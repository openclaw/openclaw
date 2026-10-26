import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMetaForEntryAsync } from "../../acp/runtime/session-meta-readonly.js";
import { isSessionFileEntry } from "../../agents/sessions/session-file-parser.js";
import {
  migrateSessionEntries,
  type FileEntry as SessionFileEntry,
  type SessionEntry as AgentSessionEntry,
  type SessionHeader,
} from "../../agents/sessions/session-manager.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { scanSessionTranscriptTree } from "../../config/sessions/transcript-tree.js";
import { FsSafeError, isPathInside, root, type Root } from "../../infra/fs-safe.js";
import type { ReplyPayload } from "../types.js";
import {
  parseExportCommandOutputPath,
  resolveExportCommandSessionTarget,
} from "./commands-export-common.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

const EXPORT_HTML_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "export-html");

const BACKEND_DELEGATED_WARNING =
  "This session was handled by a backend runtime (e.g. CLI/ACP). Assistant replies, tool calls, and usage data are stored in the backend transcript and are not included in this export.";

const MAX_DEFAULT_FILENAME_ATTEMPTS = 100;

function addCollisionSuffix(filePath: string, suffix: number): string {
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  return path.join(path.dirname(filePath), `${baseName}-${suffix}${ext}`);
}

async function createUnusedFile(
  workspaceRoot: Root,
  filePath: string,
  contents: string,
): Promise<string> {
  for (let suffix = 1; suffix <= MAX_DEFAULT_FILENAME_ATTEMPTS; suffix++) {
    const candidate = suffix === 1 ? filePath : addCollisionSuffix(filePath, suffix);
    try {
      await workspaceRoot.create(candidate, contents, { encoding: "utf-8" });
      return candidate;
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "already-exists") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not find an unused export filename near ${filePath}`);
}

function normalizeWorkspaceAliasPath(workspaceRoot: Root, requestedPath: string): string {
  if (!path.isAbsolute(requestedPath)) {
    return requestedPath;
  }
  const normalizedRequest = path.resolve(requestedPath);
  if (!isPathInside(workspaceRoot.rootDir, normalizedRequest)) {
    return requestedPath;
  }
  return path.relative(workspaceRoot.rootDir, normalizedRequest) || requestedPath;
}

type SessionExportWarningSummary = {
  count: number;
  rows: number[];
};

async function loadTemplate(fileName: string): Promise<string> {
  return await fsp.readFile(path.join(EXPORT_HTML_DIR, fileName), "utf-8");
}

function formatSessionExportWarning(summary: SessionExportWarningSummary): string {
  const rows =
    summary.rows.length > 0
      ? ` rows ${summary.rows.join(", ")}${summary.count > summary.rows.length ? ", …" : ""}`
      : "";
  const entryDescription =
    summary.count === 1 ? "row that was not a session entry" : "rows that were not session entries";
  return `⚠️ Skipped ${summary.count.toLocaleString()} malformed transcript ${entryDescription}.${rows}`;
}

export async function buildExportSessionReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, [
    "export-session",
    "export",
  ]);
  if (args.error) {
    return { text: args.error };
  }
  const sessionTarget = await resolveExportCommandSessionTarget(params);
  if ("text" in sessionTarget) {
    return sessionTarget;
  }
  const { entry } = sessionTarget;

  // Active exports run after startup migration, so SQLite rows are canonical.
  // Do not read sessionFile here; a SQLite marker is an identifier, not a path.
  const events = await loadTranscriptEvents({
    agentId: sessionTarget.agentId,
    sessionId: sessionTarget.sessionId,
    sessionKey: sessionTarget.sessionKey,
    storePath: sessionTarget.storePath,
  });
  const fileEntries: SessionFileEntry[] = [];
  const skippedRows: SessionExportWarningSummary = { count: 0, rows: [] };
  for (const [index, event] of events.entries()) {
    if (isSessionFileEntry(event)) {
      fileEntries.push(event);
    } else {
      skippedRows.count += 1;
      if (skippedRows.rows.length < 20) {
        skippedRows.rows.push(index + 1);
      }
    }
  }
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((fileEntry): fileEntry is SessionHeader => fileEntry.type === "session") ??
    null;
  const rawEntries = fileEntries.filter(
    (fileEntry): fileEntry is AgentSessionEntry => fileEntry.type !== "session",
  );
  const tree = scanSessionTranscriptTree(rawEntries);
  const hasLeafControl = tree.hasLeafControl;
  const entries = hasLeafControl
    ? rawEntries.map((fileEntry) => {
        const node = tree.byId.get(fileEntry.id);
        return node && fileEntry.parentId !== node.parentId
          ? { ...fileEntry, parentId: node.parentId }
          : fileEntry;
      })
    : rawEntries;
  const leafId = tree.leafId;
  const warnings = skippedRows.count > 0 ? [skippedRows] : [];

  const { systemPrompt, tools } = await resolveCommandsSystemPromptBundle({
    ...params,
    sessionEntry: entry,
  });

  const acpRead = {
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    entry,
  };
  let hasStoredAcpSession = Boolean(acpRead.entry.acp);
  if (!hasStoredAcpSession) {
    try {
      hasStoredAcpSession = Boolean(await readAcpSessionMetaForEntryAsync(acpRead));
    } catch {
      hasStoredAcpSession = false;
    }
  }
  const hasBackendSession =
    hasStoredAcpSession ||
    hasNonEmptyString(entry.claudeCliSessionId) ||
    Object.values(entry.cliSessionBindings ?? {}).some((binding) =>
      hasNonEmptyString(binding?.sessionId),
    ) ||
    Object.values(entry.cliSessionIds ?? {}).some(hasNonEmptyString);
  const backendWarning =
    hasBackendSession &&
    entries.some((fileEntry) => fileEntry.type === "message") &&
    entries.every((fileEntry) => fileEntry.type !== "message" || fileEntry.message.role === "user")
      ? BACKEND_DELEGATED_WARNING
      : undefined;
  const sessionData = {
    header,
    entries,
    leafId,
    hasLeafControl,
    systemPrompt,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    warning: backendWarning,
  };

  const [template, templateCss, templateJs, markedJs, hljsJs] = await Promise.all([
    loadTemplate("template.html"),
    loadTemplate("template.css"),
    loadTemplate("template.js"),
    loadTemplate(path.join("vendor", "marked.min.js")),
    loadTemplate(path.join("vendor", "highlight.min.js")),
  ]);

  const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

  const replacements: Array<[string, string]> = [
    ["CSS", templateCss],
    ["SESSION_DATA", sessionDataBase64],
    ["MARKED_JS", markedJs],
    ["HIGHLIGHT_JS", hljsJs],
    ["JS", templateJs],
  ];
  const html = replacements.reduce((currentHtml, [name, value]) => {
    let replaced = false;
    const placeholder = new RegExp(
      `(<(?:script|style)\\b(?=[^>]*\\bdata-openclaw-export-placeholder="${name}")[^>]*>)(</(?:script|style)>)`,
    );
    const next = currentHtml.replace(
      placeholder,
      (_match: string, openTag: string, closeTag: string) => {
        replaced = true;
        const finalOpenTag = openTag.replace(/\sdata-openclaw-export-placeholder="[^"]*"/, "");
        return `${finalOpenTag}${value}${closeTag}`;
      },
    );
    if (!replaced) {
      throw new Error(`Export HTML template missing ${name} placeholder`);
    }
    return next;
  }, template);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFileName = `openclaw-session-${entry.sessionId.slice(0, 8)}-${timestamp}.html`;
  let displayPath: string;
  try {
    const workspaceRoot = await root(params.workspaceDir, { mkdir: true, mode: 0o600 });
    let writtenPath: string;
    if (args.outputPath) {
      // Explicit regular files retain overwrite behavior. Rebase only lexical workspace
      // aliases onto the canonical Root; nested aliases, symlinks, and outside paths
      // still reach fs-safe unchanged and are blocked.
      writtenPath = normalizeWorkspaceAliasPath(workspaceRoot, args.outputPath);
      await workspaceRoot.write(writtenPath, html, { encoding: "utf-8" });
    } else {
      writtenPath = await createUnusedFile(workspaceRoot, defaultFileName, html);
    }
    const absolutePath = await workspaceRoot.resolve(writtenPath);
    const relativePath = path.relative(workspaceRoot.rootReal, absolutePath);
    displayPath = relativePath.startsWith("..") ? absolutePath : relativePath;
  } catch (error) {
    if (error instanceof FsSafeError && error.category === "policy") {
      return { text: "❌ Output path must be a regular file inside the workspace." };
    }
    throw error;
  }

  return {
    text: [
      "✅ Session exported!",
      "",
      `📄 File: ${displayPath}`,
      `📊 Entries: ${entries.length}`,
      ...warnings.map(formatSessionExportWarning),
      ...(backendWarning ? [`⚠️ ${backendWarning}`] : []),
      `🧠 System prompt: ${systemPrompt.length.toLocaleString()} chars`,
      `🔧 Tools: ${tools.length}`,
    ].join("\n"),
  };
}

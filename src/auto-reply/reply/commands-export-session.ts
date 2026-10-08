import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMetaForEntry } from "../../acp/runtime/session-meta-readonly.js";
import { isSessionFileEntry } from "../../agents/sessions/session-file-parser.js";
import {
  migrateSessionEntries,
  type FileEntry as SessionFileEntry,
  type SessionEntry as AgentSessionEntry,
  type SessionHeader,
} from "../../agents/sessions/session-manager.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { scanSessionTranscriptTree } from "../../config/sessions/transcript-tree.js";
import type { SessionEntry as StoredSessionEntry } from "../../config/sessions/types.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import type { ReplyPayload } from "../types.js";
import {
  parseExportCommandOutputPath,
  resolveExportCommandSessionTarget,
} from "./commands-export-common.js";
import { writeSessionExportFile } from "./commands-export-session-file.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

const EXPORT_HTML_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "export-html");

interface SessionData {
  header: SessionHeader | null;
  entries: AgentSessionEntry[];
  leafId: string | null;
  hasLeafControl: boolean;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
  warning?: string;
}

const BACKEND_DELEGATED_WARNING =
  "This session was handled by a backend runtime (e.g. CLI/ACP). Assistant replies, tool calls, and usage data are stored in the backend transcript and are not included in this export.";

function hasPersistedAcpSession(params: {
  sessionKey: string;
  entry: StoredSessionEntry;
}): boolean {
  if (params.entry.acp) {
    return true;
  }
  try {
    return Boolean(readAcpSessionMetaForEntry(params));
  } catch {
    return false;
  }
}

function isBackendDelegatedSession(
  storedEntry: StoredSessionEntry,
  entries: AgentSessionEntry[],
  hasStoredAcpSession: boolean,
): boolean {
  const hasBackendSession =
    hasStoredAcpSession ||
    hasNonEmptyString(storedEntry.claudeCliSessionId) ||
    Object.values(storedEntry.cliSessionBindings ?? {}).some((binding) =>
      hasNonEmptyString(binding?.sessionId),
    ) ||
    Object.values(storedEntry.cliSessionIds ?? {}).some(hasNonEmptyString);
  if (!hasBackendSession) {
    return false;
  }
  return (
    entries.some((entry) => entry.type === "message") &&
    entries.every((entry) => entry.type !== "message" || entry.message.role === "user")
  );
}

type SessionExportWarningSummary = {
  count: number;
  rows: number[];
};

async function loadTemplate(fileName: string): Promise<string> {
  return await fsp.readFile(path.join(EXPORT_HTML_DIR, fileName), "utf-8");
}

function replaceHtmlPlaceholder(template: string, name: string, value: string): string {
  let replaced = false;
  const placeholder = new RegExp(
    `(<(?:script|style)\\b(?=[^>]*\\bdata-openclaw-export-placeholder="${name}")[^>]*>)(</(?:script|style)>)`,
  );
  const next = template.replace(
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
}

async function generateHtml(sessionData: SessionData): Promise<string> {
  const [template, templateCss, templateJs, markedJs, hljsJs] = await Promise.all([
    loadTemplate("template.html"),
    loadTemplate("template.css"),
    loadTemplate("template.js"),
    loadTemplate(path.join("vendor", "marked.min.js")),
    loadTemplate(path.join("vendor", "highlight.min.js")),
  ]);

  const themeVars = `
    --cyan: #00d7ff;
    --blue: #5f87ff;
    --green: #b5bd68;
    --red: #cc6666;
    --yellow: #ffff00;
    --gray: #808080;
    --dimGray: #666666;
    --darkGray: #505050;
    --accent: #8abeb7;
    --selectedBg: #3a3a4a;
    --userMsgBg: #343541;
    --toolPendingBg: #282832;
    --toolSuccessBg: #283228;
    --toolErrorBg: #3c2828;
    --customMsgBg: #2d2838;
    --text: #e0e0e0;
    --dim: #666666;
    --muted: #808080;
    --border: #5f87ff;
    --borderAccent: #00d7ff;
    --borderMuted: #505050;
    --success: #b5bd68;
    --error: #cc6666;
    --warning: #ffff00;
    --thinkingText: #808080;
    --userMessageBg: #343541;
    --userMessageText: #e0e0e0;
    --customMessageBg: #2d2838;
    --customMessageText: #e0e0e0;
    --customMessageLabel: #9575cd;
    --toolTitle: #e0e0e0;
    --toolOutput: #808080;
    --mdHeading: #f0c674;
    --mdLink: #81a2be;
    --mdLinkUrl: #666666;
    --mdCode: #8abeb7;
    --mdCodeBlock: #b5bd68;
  `;
  const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

  const css = templateCss
    .replace("/* {{THEME_VARS}} */", themeVars.trim())
    .replace("/* {{BODY_BG_DECL}} */", "--body-bg: #1e1e28;")
    .replace("/* {{CONTAINER_BG_DECL}} */", "--container-bg: #282832;")
    .replace("/* {{INFO_BG_DECL}} */", "--info-bg: #343541;");

  const replacements: Array<[string, string]> = [
    ["CSS", css],
    ["SESSION_DATA", sessionDataBase64],
    ["MARKED_JS", markedJs],
    ["HIGHLIGHT_JS", hljsJs],
    ["JS", templateJs],
  ];
  return replacements.reduce(
    (html, [name, value]) => replaceHtmlPlaceholder(html, name, value),
    template,
  );
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

async function readSessionDataFromIdentity(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<
  Pick<SessionData, "header" | "entries" | "leafId" | "hasLeafControl"> & {
    warnings: SessionExportWarningSummary[];
  }
> {
  const events = await loadTranscriptEvents(params);
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
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const rawEntries = fileEntries.filter(
    (entry): entry is AgentSessionEntry => entry.type !== "session",
  );
  const tree = scanSessionTranscriptTree(rawEntries);
  const hasLeafControl = tree.hasLeafControl;
  const entries = hasLeafControl
    ? rawEntries.map((entry) => {
        const node = tree.byId.get(entry.id);
        return node && entry.parentId !== node.parentId
          ? ({ ...entry, parentId: node.parentId } as AgentSessionEntry)
          : entry;
      })
    : rawEntries;
  return {
    header,
    entries,
    leafId: tree.leafId,
    hasLeafControl,
    warnings: skippedRows.count > 0 ? [skippedRows] : [],
  };
}

export async function buildExportSessionReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, [
    "export-session",
    "export",
  ]);
  if (args.error) {
    return { text: args.error };
  }
  const sessionTarget = resolveExportCommandSessionTarget(params);
  if ("text" in sessionTarget) {
    return sessionTarget;
  }
  const { entry } = sessionTarget;

  // Active exports run after startup migration, so SQLite rows are canonical.
  // Do not read sessionFile here; a SQLite marker is an identifier, not a path.
  const { entries, header, leafId, hasLeafControl, warnings } = await readSessionDataFromIdentity({
    agentId: sessionTarget.agentId,
    sessionId: sessionTarget.sessionId,
    sessionKey: sessionTarget.sessionKey,
    storePath: sessionTarget.storePath,
  });

  const { systemPrompt, tools } = await resolveCommandsSystemPromptBundle({
    ...params,
    sessionEntry: entry,
  });

  const hasStoredAcpSession = hasPersistedAcpSession({
    sessionKey: params.sessionKey,
    entry,
  });
  const backendWarning = isBackendDelegatedSession(entry, entries, hasStoredAcpSession)
    ? BACKEND_DELEGATED_WARNING
    : undefined;
  const sessionData: SessionData = {
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

  const html = await generateHtml(sessionData);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFileName = `openclaw-session-${entry.sessionId.slice(0, 8)}-${timestamp}.html`;
  let displayPath: string;
  try {
    const written = await writeSessionExportFile({
      workspaceDir: params.workspaceDir,
      requestedPath: args.outputPath,
      defaultFileName,
      contents: html,
    });
    displayPath = written.displayPath;
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

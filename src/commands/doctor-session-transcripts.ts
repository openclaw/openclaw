import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../agents/internal-runtime-context.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { resolveStateDir } from "../config/paths.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import {
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const CODEX_APP_SERVER_BINDING_SIDECAR_SUFFIX = ".codex-app-server.json";
const CODEX_APP_SERVER_BINDING_KV_SCOPE = "codex_app_server_thread_bindings";

type TranscriptEntry = Record<string, unknown> & {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  message?: unknown;
};

type TranscriptRepairResult = {
  filePath: string;
  broken: boolean;
  repaired: boolean;
  originalEntries: number;
  activeEntries: number;
  reason?: string;
};

type TranscriptMigrationResult = TranscriptRepairResult & {
  imported: boolean;
  removedSource: boolean;
  sessionId?: string;
};

type CodexAppServerBindingMigrationResult = {
  filePath: string;
  legacyTranscriptPath: string;
  sessionId: string;
  imported: boolean;
  removedSource: boolean;
  reason?: string;
};

function parseTranscriptEntries(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as TranscriptEntry);
      }
    } catch {
      return [];
    }
  }
  return entries;
}

function getSessionId(entries: TranscriptEntry[]): string | null {
  const header = entries.find((entry) => entry.type === "session");
  return typeof header?.id === "string" && header.id.trim() ? header.id : null;
}

function resolveAgentIdFromTranscriptPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const sessionsDir = path.dirname(resolved);
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(sessionsDir) === "sessions" && path.basename(agentsDir) === "agents") {
    return normalizeAgentId(path.basename(agentDir));
  }
  return DEFAULT_AGENT_ID;
}

function getEntryId(entry: TranscriptEntry): string | null {
  return typeof entry.id === "string" && entry.id.trim() ? entry.id : null;
}

function getParentId(entry: TranscriptEntry): string | null {
  return typeof entry.parentId === "string" && entry.parentId.trim() ? entry.parentId : null;
}

function getMessage(entry: TranscriptEntry): Record<string, unknown> | null {
  return entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
    ? (entry.message as Record<string, unknown>)
    : null;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
  return text || null;
}

function selectActivePath(entries: TranscriptEntry[]): TranscriptEntry[] | null {
  const sessionEntries = entries.filter((entry) => entry.type !== "session");
  const leaf = sessionEntries.at(-1);
  const leafId = leaf ? getEntryId(leaf) : null;
  if (!leaf || !leafId) {
    return null;
  }

  const byId = new Map<string, TranscriptEntry>();
  for (const entry of sessionEntries) {
    const id = getEntryId(entry);
    if (id) {
      byId.set(id, entry);
    }
  }

  const active: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: TranscriptEntry | undefined = leaf;
  while (current) {
    const id = getEntryId(current);
    if (!id || seen.has(id)) {
      return null;
    }
    seen.add(id);
    active.unshift(current);
    const parentId = getParentId(current);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return active;
}

function hasBrokenPromptRewriteBranch(entries: TranscriptEntry[], activePath: TranscriptEntry[]) {
  const activeIds = new Set(activePath.map(getEntryId).filter((id): id is string => Boolean(id)));
  const activeUserByParentAndText = new Set<string>();

  for (const entry of activePath) {
    const id = getEntryId(entry);
    const message = getMessage(entry);
    if (!id || message?.role !== "user") {
      continue;
    }
    const text = textFromContent(message.content);
    if (text !== null) {
      activeUserByParentAndText.add(`${getParentId(entry) ?? ""}\0${text.trim()}`);
    }
  }

  for (const entry of entries) {
    const id = getEntryId(entry);
    if (!id || activeIds.has(id)) {
      continue;
    }
    const message = getMessage(entry);
    if (message?.role !== "user") {
      continue;
    }
    const text = textFromContent(message.content);
    if (!text || !hasInternalRuntimeContext(text)) {
      continue;
    }
    const visibleText = stripInternalRuntimeContext(text).trim();
    if (
      visibleText &&
      activeUserByParentAndText.has(`${getParentId(entry) ?? ""}\0${visibleText}`)
    ) {
      return true;
    }
  }
  return false;
}

export async function migrateSessionTranscriptFileToSqlite(params: {
  filePath: string;
  shouldRepair: boolean;
  agentId?: string;
  transcriptPath?: string;
}): Promise<TranscriptMigrationResult> {
  try {
    const raw = await fs.readFile(params.filePath, "utf-8");
    const entries = parseTranscriptEntries(raw);
    const sessionId = getSessionId(entries);
    if (!sessionId) {
      return {
        filePath: params.filePath,
        broken: false,
        repaired: false,
        imported: false,
        removedSource: false,
        originalEntries: entries.length,
        activeEntries: 0,
        reason: "missing session header",
      };
    }

    const activePath = selectActivePath(entries);
    const broken = activePath ? hasBrokenPromptRewriteBranch(entries, activePath) : false;
    const header = entries.find((entry) => entry.type === "session");
    const events =
      broken && params.shouldRepair && activePath && header ? [header, ...activePath] : entries;

    if (!params.shouldRepair) {
      return {
        filePath: params.filePath,
        broken,
        repaired: false,
        imported: false,
        removedSource: false,
        originalEntries: entries.length,
        activeEntries: activePath?.length ?? 0,
        sessionId,
      };
    }

    const transcriptPath = path.resolve(params.transcriptPath ?? params.filePath);
    replaceSqliteSessionTranscriptEvents({
      agentId: params.agentId ?? resolveAgentIdFromTranscriptPath(transcriptPath),
      sessionId,
      events,
    });
    await fs.rm(params.filePath, { force: true });

    return {
      filePath: params.filePath,
      broken,
      repaired: broken,
      imported: true,
      removedSource: true,
      originalEntries: entries.length,
      activeEntries: activePath?.length ?? 0,
      sessionId,
    };
  } catch (err) {
    return {
      filePath: params.filePath,
      broken: false,
      repaired: false,
      imported: false,
      removedSource: false,
      originalEntries: 0,
      activeEntries: 0,
      reason: String(err),
    };
  }
}

async function listSessionTranscriptFiles(sessionDirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const sessionsDir of sessionDirs) {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(sessionsDir, entry.name));
      }
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

async function listCodexAppServerBindingSidecars(sessionDirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const sessionsDir of sessionDirs) {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(CODEX_APP_SERVER_BINDING_SIDECAR_SUFFIX)) {
        files.push(path.join(sessionsDir, entry.name));
      }
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

function resolveCodexAppServerBindingTranscriptPath(sidecarPath: string): string {
  return sidecarPath.slice(0, -CODEX_APP_SERVER_BINDING_SIDECAR_SUFFIX.length);
}

async function resolveCodexAppServerBindingSessionId(
  legacyTranscriptPath: string,
): Promise<string> {
  try {
    const raw = await fs.readFile(legacyTranscriptPath, "utf-8");
    const sessionId = getSessionId(parseTranscriptEntries(raw));
    if (sessionId) {
      return sessionId;
    }
  } catch {
    // Fall back to the legacy filename when only the sidecar survived.
  }
  const basename = path.basename(legacyTranscriptPath);
  return basename.endsWith(".jsonl") ? basename.slice(0, -".jsonl".length) : basename;
}

function normalizeCodexAppServerBindingPayload(
  sessionId: string,
  value: unknown,
): OpenClawStateJsonValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const parsed = value as Record<string, unknown>;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.threadId !== "string" ||
    !parsed.threadId.trim()
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    sessionId,
    threadId: parsed.threadId,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    authProfileId: typeof parsed.authProfileId === "string" ? parsed.authProfileId : undefined,
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : undefined,
    approvalPolicy: typeof parsed.approvalPolicy === "string" ? parsed.approvalPolicy : undefined,
    sandbox: typeof parsed.sandbox === "string" ? parsed.sandbox : undefined,
    serviceTier: typeof parsed.serviceTier === "string" ? parsed.serviceTier : undefined,
    dynamicToolsFingerprint:
      typeof parsed.dynamicToolsFingerprint === "string"
        ? parsed.dynamicToolsFingerprint
        : undefined,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
  } as OpenClawStateJsonValue;
}

async function migrateCodexAppServerBindingSidecar(params: {
  filePath: string;
  shouldRepair: boolean;
}): Promise<CodexAppServerBindingMigrationResult> {
  const legacyTranscriptPath = resolveCodexAppServerBindingTranscriptPath(params.filePath);
  const sessionId = await resolveCodexAppServerBindingSessionId(legacyTranscriptPath);
  try {
    const raw = await fs.readFile(params.filePath, "utf-8");
    const payload = normalizeCodexAppServerBindingPayload(sessionId, JSON.parse(raw));
    if (!payload) {
      return {
        filePath: params.filePath,
        legacyTranscriptPath,
        sessionId,
        imported: false,
        removedSource: false,
        reason: "invalid binding payload",
      };
    }
    if (!params.shouldRepair) {
      return {
        filePath: params.filePath,
        legacyTranscriptPath,
        sessionId,
        imported: false,
        removedSource: false,
      };
    }
    writeOpenClawStateKvJson(CODEX_APP_SERVER_BINDING_KV_SCOPE, sessionId, payload);
    await fs.rm(params.filePath, { force: true });
    return {
      filePath: params.filePath,
      legacyTranscriptPath,
      sessionId,
      imported: true,
      removedSource: true,
    };
  } catch (error) {
    return {
      filePath: params.filePath,
      legacyTranscriptPath,
      sessionId,
      imported: false,
      removedSource: false,
      reason: String(error),
    };
  }
}

export async function noteSessionTranscriptHealth(params?: {
  shouldRepair?: boolean;
  sessionDirs?: string[];
}) {
  const shouldRepair = params?.shouldRepair === true;
  let sessionDirs = params?.sessionDirs;
  try {
    sessionDirs ??= await resolveAgentSessionDirs(resolveStateDir(process.env));
  } catch (err) {
    note(`- Failed to inspect session transcripts: ${String(err)}`, "Session transcripts");
    return;
  }

  const files = await listSessionTranscriptFiles(sessionDirs);
  const codexBindingSidecars = await listCodexAppServerBindingSidecars(sessionDirs);
  if (files.length === 0 && codexBindingSidecars.length === 0) {
    return;
  }

  const codexBindingResults: CodexAppServerBindingMigrationResult[] = [];
  for (const filePath of codexBindingSidecars) {
    codexBindingResults.push(await migrateCodexAppServerBindingSidecar({ filePath, shouldRepair }));
  }
  const results: TranscriptMigrationResult[] = [];
  for (const filePath of files) {
    results.push(await migrateSessionTranscriptFileToSqlite({ filePath, shouldRepair }));
  }
  const broken = results.filter((result) => result.broken);
  const imported = results.filter((result) => result.imported);
  const failed = results.filter((result) => result.reason && !result.imported);
  const importedCodexBindings = codexBindingResults.filter((result) => result.imported);
  const failedCodexBindings = codexBindingResults.filter(
    (result) => result.reason && !result.imported,
  );

  const repairedCount = broken.filter((result) => result.repaired).length;
  const legacyCount = results.length;
  const lines: string[] = [];
  if (legacyCount > 0) {
    lines.push(
      `- Found ${legacyCount} legacy transcript JSONL file${legacyCount === 1 ? "" : "s"} outside the SQLite session database.`,
    );
    lines.push(
      ...results.slice(0, 20).map((result) => {
        const status = result.imported
          ? result.repaired
            ? "imported with active-branch repair"
            : "imported"
          : result.broken
            ? "needs import + repair"
            : "needs import";
        const reason = result.reason ? ` reason=${result.reason}` : "";
        return `- ${shortenHomePath(result.filePath)} ${status} entries=${result.originalEntries}${reason}`;
      }),
    );
  }
  if (results.length > 20) {
    lines.push(`- ...and ${results.length - 20} more.`);
  }
  if (codexBindingResults.length > 0) {
    lines.push(
      `- Found ${codexBindingResults.length} legacy Codex app-server binding sidecar${codexBindingResults.length === 1 ? "" : "s"} outside the SQLite state database.`,
    );
    lines.push(
      ...codexBindingResults.slice(0, 20).map((result) => {
        const status = result.imported ? "imported" : "needs import";
        const reason = result.reason ? ` reason=${result.reason}` : "";
        return `- ${shortenHomePath(result.filePath)} ${status}${reason}`;
      }),
    );
    if (codexBindingResults.length > 20) {
      lines.push(`- ...and ${codexBindingResults.length - 20} more.`);
    }
  }
  if (!shouldRepair) {
    lines.push('- Run "openclaw doctor --fix" to import legacy session files into SQLite.');
  } else if (imported.length > 0) {
    lines.push(
      `- Imported ${imported.length} transcript file${imported.length === 1 ? "" : "s"} into SQLite and removed the JSONL source${imported.length === 1 ? "" : "s"}.`,
    );
    if (repairedCount > 0) {
      lines.push(
        `- Repaired duplicated prompt-rewrite branches for ${repairedCount} transcript file${repairedCount === 1 ? "" : "s"} during import.`,
      );
    }
  }
  if (shouldRepair && importedCodexBindings.length > 0) {
    lines.push(
      `- Imported ${importedCodexBindings.length} Codex app-server binding sidecar${importedCodexBindings.length === 1 ? "" : "s"} into SQLite and removed the JSON source${importedCodexBindings.length === 1 ? "" : "s"}.`,
    );
  }
  if (failed.length > 0) {
    lines.push(
      `- Could not import ${failed.length} transcript file${failed.length === 1 ? "" : "s"}; left source file${failed.length === 1 ? "" : "s"} in place.`,
    );
  }
  if (failedCodexBindings.length > 0) {
    lines.push(
      `- Could not import ${failedCodexBindings.length} Codex app-server binding sidecar${failedCodexBindings.length === 1 ? "" : "s"}; left source file${failedCodexBindings.length === 1 ? "" : "s"} in place.`,
    );
  }

  note(lines.join("\n"), "Session transcripts");
}

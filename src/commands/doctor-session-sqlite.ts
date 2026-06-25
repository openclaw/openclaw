/** Doctor submode for migrating legacy session JSON/JSONL state into SQLite. */
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { loadConfig } from "../config/io.js";
import { resolveSessionFilePath } from "../config/sessions/paths.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import {
  importSqliteSessionRows,
  listSqliteSessionEntries,
  loadExactSqliteSessionEntry,
  loadSqliteTranscriptEventsSync,
} from "../config/sessions/session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreTarget,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";

export type DoctorSessionSqliteMode = "dry-run" | "import" | "validate" | "inspect";

export type DoctorSessionSqliteOptions = {
  allAgents?: boolean;
  agent?: string;
  env?: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
};

export type DoctorSessionSqliteIssue = {
  code: string;
  message: string;
  sessionKey?: string;
};

export type DoctorSessionSqliteTargetReport = {
  agentId: string;
  archivedTranscriptFiles: string[];
  importedEntries: number;
  importedTranscriptEvents: number;
  issues: DoctorSessionSqliteIssue[];
  legacyEntries: number;
  referencedTranscriptFiles: number;
  sqliteEntries: number;
  sqlitePath: string;
  storePath: string;
  unreferencedJsonlFiles: string[];
  validatedEntries: number;
  validatedTranscriptEvents: number;
};

export type DoctorSessionSqliteReport = {
  mode: DoctorSessionSqliteMode;
  targets: DoctorSessionSqliteTargetReport[];
  totals: {
    archivedTranscriptFiles: number;
    importedEntries: number;
    importedTranscriptEvents: number;
    issues: number;
    legacyEntries: number;
    sqliteEntries: number;
    targets: number;
    unreferencedJsonlFiles: number;
    validatedEntries: number;
    validatedTranscriptEvents: number;
  };
};

type LegacySessionRecord = {
  entry: SessionEntry;
  sessionKey: string;
  transcriptPath?: string;
};

const JSONL_READ_CHUNK_BYTES = 64 * 1024;

/** Runs the targeted doctor SQLite session migration/inspection submode. */
export async function runDoctorSessionSqlite(
  options: DoctorSessionSqliteOptions,
): Promise<DoctorSessionSqliteReport> {
  const env = options.env ?? process.env;
  const cfg = loadConfig({
    pin: false,
    skipPluginValidation: true,
    skipShellEnvFallback: true,
  });
  const targets = resolveDoctorSessionSqliteTargets({
    allAgents: options.allAgents,
    agent: options.agent,
    cfg,
    env,
    store: options.store,
  });
  const reports: DoctorSessionSqliteTargetReport[] = [];
  for (const target of targets) {
    reports.push(await inspectOrMigrateTarget({ env, mode: options.mode, target }));
  }
  return summarizeDoctorSessionSqliteReport(options.mode, reports);
}

function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: ReturnType<typeof loadConfig>;
  env: NodeJS.ProcessEnv;
  store?: string;
}): SessionStoreTarget[] {
  if (params.store) {
    return resolveSessionStoreTargets(
      params.cfg,
      { store: params.store },
      { env: params.env },
    ).filter((target) => fs.existsSync(target.storePath));
  }
  if (params.agent) {
    return resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env });
  }
  if (params.allAgents) {
    return resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env });
  }
  return resolveSessionStoreTargets(params.cfg, {}, { env: params.env }).filter((target) =>
    fs.existsSync(target.storePath),
  );
}

async function inspectOrMigrateTarget(params: {
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  target: SessionStoreTarget;
}): Promise<DoctorSessionSqliteTargetReport> {
  const issues: DoctorSessionSqliteIssue[] = [];
  const records = readLegacySessionRecords(params.target, issues);
  const referencedTranscriptFiles = new Set(
    records.flatMap((record) => (record.transcriptPath ? [record.transcriptPath] : [])),
  );
  const report: DoctorSessionSqliteTargetReport = {
    agentId: params.target.agentId,
    archivedTranscriptFiles: [],
    importedEntries: 0,
    importedTranscriptEvents: 0,
    issues,
    legacyEntries: records.length,
    referencedTranscriptFiles: referencedTranscriptFiles.size,
    sqliteEntries: readSqliteEntryCount(params.target),
    sqlitePath: resolveTargetSqlitePath(params.target),
    storePath: params.target.storePath,
    unreferencedJsonlFiles: listUnreferencedJsonlFiles(params.target.storePath, [
      ...referencedTranscriptFiles,
    ]),
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
  };
  if (params.mode === "inspect") {
    report.sqliteEntries = readSqliteEntryCount(params.target);
    return report;
  }
  for (const record of records) {
    if (params.mode === "dry-run") {
      countLegacyTranscript(record, report);
      continue;
    }
    if (params.mode === "import") {
      await importLegacySessionRecord(params.target, record, report);
      continue;
    }
    validateLegacySessionRecord(params.target, record, report);
  }
  report.sqliteEntries = readSqliteEntryCount(params.target);
  return report;
}

function readLegacySessionRecords(
  target: SessionStoreTarget,
  issues: DoctorSessionSqliteIssue[],
): LegacySessionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target.storePath, "utf-8"));
  } catch (err) {
    issues.push({
      code: "store_unreadable",
      message: `${target.storePath}: ${String(err)}`,
    });
    return [];
  }
  if (!isRecord(parsed)) {
    issues.push({
      code: "store_not_object",
      message: `${target.storePath} does not contain an object session store.`,
    });
    return [];
  }
  const records: LegacySessionRecord[] = [];
  for (const [sessionKey, value] of Object.entries(parsed)) {
    if (!isSessionEntry(value)) {
      issues.push({
        code: "entry_invalid",
        message: "Session entry is missing a valid sessionId.",
        sessionKey,
      });
      continue;
    }
    records.push({
      entry: value,
      sessionKey,
      transcriptPath: resolveLegacyTranscriptPath(target, value),
    });
  }
  return records;
}

function resolveLegacyTranscriptPath(
  target: SessionStoreTarget,
  entry: SessionEntry,
): string | undefined {
  const defaultPath = resolveSessionFilePath(entry.sessionId, entry, {
    agentId: target.agentId,
    sessionsDir: path.dirname(target.storePath),
  });
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  return entry.sessionFile?.trim() ? defaultPath : undefined;
}

function countLegacyTranscript(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = countTranscriptEvents(record);
  if (result.status === "missing") {
    report.issues.push({
      code: "transcript_missing",
      message: `Transcript file is missing: ${record.transcriptPath}`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (result.status === "malformed") {
    report.issues.push({
      code: "transcript_malformed",
      message: result.message,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += result.events;
}

async function importLegacySessionRecord(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): Promise<void> {
  const result = countTranscriptEvents(record);
  if (result.status === "missing") {
    if (markAlreadyMigratedTranscript(target, record, report)) {
      return;
    }
    report.issues.push({
      code: "transcript_missing",
      message: `Transcript file is missing: ${record.transcriptPath}`,
      sessionKey: record.sessionKey,
    });
    return;
  } else if (result.status === "malformed") {
    report.issues.push({
      code: "transcript_malformed",
      message: result.message,
      sessionKey: record.sessionKey,
    });
    return;
  }
  const imported = await importSqliteSessionRows({
    agentId: target.agentId,
    entry: normalizeImportedSqliteSessionEntry(target, record),
    sessionKey: record.sessionKey,
    storePath: target.storePath,
    ...(record.transcriptPath && result.status === "ok"
      ? { readTranscriptEvents: createTranscriptEventReader(record.transcriptPath) }
      : {}),
  });
  report.importedEntries += 1;
  report.importedTranscriptEvents += imported.transcriptEvents;
  if (record.transcriptPath && result.status === "ok") {
    archiveImportedTranscript(target, record, report);
  }
}

function normalizeImportedSqliteSessionEntry(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
): SessionEntry {
  return {
    ...record.entry,
    sessionFile: formatSqliteSessionFileMarker({
      agentId: target.agentId,
      sessionId: record.entry.sessionId,
      storePath: target.storePath,
    }),
  };
}

function markAlreadyMigratedTranscript(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): boolean {
  const migratedEvents = countAlreadyMigratedTranscriptEvents(target, record);
  if (migratedEvents === undefined) {
    return false;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += migratedEvents;
  return true;
}

function archiveImportedTranscript(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): void {
  if (!record.transcriptPath || !fs.existsSync(record.transcriptPath)) {
    return;
  }
  try {
    report.archivedTranscriptFiles.push(
      moveImportedTranscriptToArchive(target, record.sessionKey, record.transcriptPath),
    );
  } catch (err) {
    report.issues.push({
      code: "transcript_archive_failed",
      message: `${record.transcriptPath}: ${String(err)}`,
      sessionKey: record.sessionKey,
    });
  }
}

function validateLegacySessionRecord(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): void {
  const normalizedKey = normalizeStoreSessionKey(record.sessionKey);
  const sqliteEntry = loadExactSqliteSessionEntry({
    agentId: target.agentId,
    sessionKey: normalizedKey,
    storePath: target.storePath,
  });
  if (!sqliteEntry) {
    report.issues.push({
      code: "sqlite_entry_missing",
      message: `SQLite entry is missing for ${normalizedKey}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteEntry.entry.sessionId !== record.entry.sessionId) {
    report.issues.push({
      code: "sqlite_entry_mismatch",
      message: `SQLite sessionId ${sqliteEntry.entry.sessionId} does not match ${record.entry.sessionId}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedEntries += 1;
  validateTranscriptEventCount(target, record, report);
}

function validateTranscriptEventCount(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = countTranscriptEvents(record);
  if (result.status === "missing") {
    const migratedEvents = countAlreadyMigratedTranscriptEvents(target, record);
    if (migratedEvents !== undefined) {
      report.validatedTranscriptEvents += migratedEvents;
    }
    return;
  }
  if (result.status !== "ok") {
    return;
  }
  const sqliteEvents = loadSqliteTranscriptEventsSync({
    agentId: target.agentId,
    sessionId: record.entry.sessionId,
    sessionKey: normalizeStoreSessionKey(record.sessionKey),
    storePath: target.storePath,
  });
  if (sqliteEvents.length !== result.events) {
    report.issues.push({
      code: "sqlite_transcript_count_mismatch",
      message: `SQLite transcript has ${sqliteEvents.length} events; source has ${result.events}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedTranscriptEvents += sqliteEvents.length;
}

function countAlreadyMigratedTranscriptEvents(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
): number | undefined {
  const normalizedKey = normalizeStoreSessionKey(record.sessionKey);
  const sqliteEntry = loadExactSqliteSessionEntry({
    agentId: target.agentId,
    sessionKey: normalizedKey,
    storePath: target.storePath,
  });
  if (sqliteEntry?.entry.sessionId !== record.entry.sessionId) {
    return undefined;
  }
  return loadSqliteTranscriptEventsSync({
    agentId: target.agentId,
    sessionId: record.entry.sessionId,
    sessionKey: normalizedKey,
    storePath: target.storePath,
  }).length;
}

function countTranscriptEvents(
  record: LegacySessionRecord,
):
  | { status: "ok"; events: number }
  | { status: "missing" }
  | { status: "malformed"; message: string } {
  if (!record.transcriptPath) {
    return { status: "ok", events: 0 };
  }
  if (!fs.existsSync(record.transcriptPath)) {
    return { status: "missing" };
  }
  let events = 0;
  try {
    for (const line of iterateJsonlLinesSync(record.transcriptPath)) {
      JSON.parse(line.text);
      events += 1;
    }
    return { status: "ok", events };
  } catch (err) {
    return { status: "malformed", message: String(err) };
  }
}

function createTranscriptEventReader(
  transcriptPath: string,
): (append: (event: TranscriptEvent) => void) => void {
  return (append) => {
    for (const line of iterateJsonlLinesSync(transcriptPath)) {
      append(JSON.parse(line.text) as TranscriptEvent);
    }
  };
}

function* iterateJsonlLinesSync(filePath: string): Generator<{ lineNumber: number; text: string }> {
  const fd = fs.openSync(filePath, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
  let carry = "";
  let lineNumber = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      carry += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const parts = carry.split(/\r?\n/);
      carry = parts.pop() ?? "";
      for (const part of parts) {
        lineNumber += 1;
        const text = part.trim();
        if (text) {
          yield { lineNumber, text };
        }
      }
    }
    carry += decoder.decode();
    const text = carry.trim();
    if (text) {
      yield { lineNumber: lineNumber + 1, text };
    }
  } catch (err) {
    throw new Error(`${filePath}:${lineNumber + 1}: ${String(err)}`);
  } finally {
    fs.closeSync(fd);
  }
}

function listUnreferencedJsonlFiles(
  storePath: string,
  referencedPaths: readonly string[],
): string[] {
  const sessionsDir = path.dirname(storePath);
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const referenced = new Set(referencedPaths.map((filePath) => canonicalFilePath(filePath)));
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => path.join(sessionsDir, entry))
    .filter((filePath) => !referenced.has(canonicalFilePath(filePath)))
    .toSorted((a, b) => a.localeCompare(b));
}

function moveImportedTranscriptToArchive(
  target: SessionStoreTarget,
  sessionKey: string,
  transcriptPath: string,
): string {
  const sourcePath = path.resolve(transcriptPath);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) {
    throw new Error("source is not a regular file");
  }
  const archiveDir = resolveImportedTranscriptArchiveDir(target.storePath);
  fs.mkdirSync(archiveDir, { recursive: true });
  const baseName = path.basename(sourcePath);
  const keySlug = sessionKey.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "session";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `.${attempt}`;
    const archivePath = path.join(
      archiveDir,
      `${keySlug}.${baseName}.imported-${Date.now()}${suffix}`,
    );
    if (fs.existsSync(archivePath)) {
      continue;
    }
    try {
      fs.renameSync(sourcePath, archivePath);
      return archivePath;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not archive imported transcript for ${sessionKey}`);
}

function resolveImportedTranscriptArchiveDir(storePath: string): string {
  const storeDir = path.dirname(path.resolve(storePath));
  return path.join(path.dirname(storeDir), "session-sqlite-import-archive");
}

function canonicalFilePath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function readSqliteEntryCount(target: SessionStoreTarget): number {
  try {
    return listSqliteSessionEntries({
      agentId: target.agentId,
      storePath: target.storePath,
    }).length;
  } catch {
    return 0;
  }
}

function resolveTargetSqlitePath(target: SessionStoreTarget): string {
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(target.storePath);
  return resolveOpenClawAgentSqlitePath({
    agentId: sqliteTarget.agentId ?? target.agentId,
    ...(sqliteTarget.path ? { path: sqliteTarget.path } : {}),
  });
}

function isSessionEntry(value: unknown): value is SessionEntry {
  return isRecord(value) && typeof value.sessionId === "string" && value.sessionId.trim() !== "";
}

function summarizeDoctorSessionSqliteReport(
  mode: DoctorSessionSqliteMode,
  targets: DoctorSessionSqliteTargetReport[],
): DoctorSessionSqliteReport {
  return {
    mode,
    targets,
    totals: {
      archivedTranscriptFiles: targets.reduce(
        (total, target) => total + target.archivedTranscriptFiles.length,
        0,
      ),
      importedEntries: sumTargets(targets, "importedEntries"),
      importedTranscriptEvents: sumTargets(targets, "importedTranscriptEvents"),
      issues: targets.reduce((total, target) => total + target.issues.length, 0),
      legacyEntries: sumTargets(targets, "legacyEntries"),
      sqliteEntries: sumTargets(targets, "sqliteEntries"),
      targets: targets.length,
      unreferencedJsonlFiles: targets.reduce(
        (total, target) => total + target.unreferencedJsonlFiles.length,
        0,
      ),
      validatedEntries: sumTargets(targets, "validatedEntries"),
      validatedTranscriptEvents: sumTargets(targets, "validatedTranscriptEvents"),
    },
  };
}

function sumTargets(
  targets: DoctorSessionSqliteTargetReport[],
  key: keyof Pick<
    DoctorSessionSqliteTargetReport,
    | "importedEntries"
    | "importedTranscriptEvents"
    | "legacyEntries"
    | "sqliteEntries"
    | "validatedEntries"
    | "validatedTranscriptEvents"
  >,
): number {
  return targets.reduce((total, target) => total + target[key], 0);
}

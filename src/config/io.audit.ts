// Audits config paths and values for diagnostics and safety checks.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { registerSqliteAuditRecordAsync } from "../infra/sqlite-audit-record-store.async.js";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import { redactSecrets } from "../logging/redact.js";
import { resolveConfigAuditStoreEnv } from "./config-journal-snapshot.js";
import type { ConfigHealthFingerprint } from "./io.health-state.types.js";
import type { ConfigWriteAuditOrigin } from "./io.types.js";
import { resolveStateDir } from "./paths.js";
import { redactSensitiveArgv } from "./redact-argv.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";

const CONFIG_AUDIT_ARGV_CAP = 8;
const CONFIG_AUDIT_PATH_CAP = 64;
const CONFIG_AUDIT_ISSUE_CAP = 64;
const CONFIG_SET_VALUE_OPTIONS = new Set([
  "--batch-file",
  "--batch-json",
  "--container",
  "--log-level",
  "--profile",
  "--provider-allowlist",
  "--provider-arg",
  "--provider-command",
  "--provider-env",
  "--provider-max-bytes",
  "--provider-max-output-bytes",
  "--provider-mode",
  "--provider-no-output-timeout-ms",
  "--provider-pass-env",
  "--provider-path",
  "--provider-source",
  "--provider-timeout-ms",
  "--provider-trusted-dir",
  "--ref-id",
  "--ref-provider",
  "--ref-source",
  "--section",
]);

function findConfigPositionals(
  argv: readonly string[],
  startIndex: number,
  maxPositionals: number,
): number[] {
  const positionals: number[] = [];
  // A parent "--" must not turn child options into config path/value positionals.
  let optionsEnded = false;
  for (
    let index = startIndex;
    index < argv.length && positionals.length < maxPositionals;
    index += 1
  ) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) {
      const equalsIndex = arg.indexOf("=");
      const optionName = equalsIndex < 0 ? arg : arg.slice(0, equalsIndex);
      if (equalsIndex < 0 && CONFIG_SET_VALUE_OPTIONS.has(optionName)) {
        index += 1;
      }
      continue;
    }
    positionals.push(index);
  }
  return positionals;
}

function redactConfigAuditArgv(argv: readonly string[]): string[] {
  const redacted = redactSensitiveArgv(argv);
  let setIndex = -1;
  for (let index = 0; index < redacted.length; index += 1) {
    if (redacted[index] !== "config") {
      continue;
    }
    const [commandIndex] = findConfigPositionals(redacted, index + 1, 1);
    if (commandIndex !== undefined && redacted[commandIndex] === "set") {
      setIndex = commandIndex;
      break;
    }
  }
  if (setIndex < 0) {
    return redacted;
  }
  for (let index = setIndex + 1; index < redacted.length; index += 1) {
    const arg = redacted[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--batch-json" && index + 1 < redacted.length) {
      redacted[index + 1] = "***";
      index += 1;
      continue;
    }
    if (arg.startsWith("--batch-json=")) {
      redacted[index] = "--batch-json=***";
    }
  }
  const positionals = findConfigPositionals(redacted, setIndex + 1, 2);
  if (positionals.length < 2) {
    return redacted;
  }
  const pathIndex = positionals[0]!;
  const valueIndex = positionals[1]!;
  const configPath = redacted[pathIndex];
  if (typeof configPath === "string" && isSensitiveConfigPath(configPath)) {
    redacted[valueIndex] = "***";
  }
  return redacted;
}

function capArgv(argv: readonly string[] | undefined): string[] {
  if (!Array.isArray(argv)) {
    return [];
  }
  return argv.slice(0, CONFIG_AUDIT_ARGV_CAP);
}

function snapshotConfigAuditProcessInfo(): ConfigAuditProcessInfo {
  return {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: redactConfigAuditArgv(capArgv(process.argv)),
    execArgv: redactConfigAuditArgv(capArgv(process.execArgv)),
  };
}

export const CONFIG_AUDIT_SCOPE = "config-audit";
export const CONFIG_AUDIT_MAX_ENTRIES = 50_000;
export const CONFIG_AUDIT_STORE_LABEL =
  "SQLite diagnostic_events/config-audit state (latest 50000 rows)";
const LEGACY_CONFIG_AUDIT_LOG_FILENAME = ["config-audit", "jsonl"].join(".");

export type ConfigWriteAuditResult = "rename" | "copy-fallback" | "failed" | "rejected";

export type ConfigExternalChangeAuditRecord = {
  ts: string;
  source: "config-io";
  event: "config.external";
  detectedBy: "watch" | "startup" | "write";
  configPath: string;
  previousHash: string | null;
  nextHash: string | null;
  valid: boolean;
  issues?: string[];
  changedPaths?: string[];
  /** Raw bytes changed but authored paths did not (comments or formatting only). */
  opaqueChange?: boolean;
};

export function createConfigObserveAuditRecord(params: {
  configPath: string;
  valid: boolean;
  current: ConfigHealthFingerprint;
  suspicious: string[];
  lastKnownGood: ConfigHealthFingerprint | undefined;
  backup: ConfigHealthFingerprint | null | undefined;
  clobberedPath?: string | null;
  restoredFromBackup?: boolean;
  restoredBackupPath?: string | null;
  restoreErrorCode?: string | null;
  restoreErrorMessage?: string | null;
}) {
  const { current, lastKnownGood, backup } = params;
  return {
    ts: current.observedAt,
    source: "config-io" as const,
    event: "config.observe" as const,
    phase: "read" as const,
    configPath: params.configPath,
    ...snapshotConfigAuditProcessInfo(),
    exists: true,
    valid: params.valid,
    hash: current.hash,
    bytes: current.bytes,
    mtimeMs: current.mtimeMs,
    ctimeMs: current.ctimeMs,
    dev: current.dev,
    ino: current.ino,
    mode: current.mode,
    nlink: current.nlink,
    uid: current.uid,
    gid: current.gid,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    suspicious: params.suspicious,
    lastKnownGoodHash: lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: lastKnownGood?.dev ?? null,
    lastKnownGoodIno: lastKnownGood?.ino ?? null,
    lastKnownGoodMode: lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: lastKnownGood?.uid ?? null,
    lastKnownGoodGid: lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: lastKnownGood?.gatewayMode ?? null,
    backupHash: backup?.hash ?? null,
    backupBytes: backup?.bytes ?? null,
    backupMtimeMs: backup?.mtimeMs ?? null,
    backupCtimeMs: backup?.ctimeMs ?? null,
    backupDev: backup?.dev ?? null,
    backupIno: backup?.ino ?? null,
    backupMode: backup?.mode ?? null,
    backupNlink: backup?.nlink ?? null,
    backupUid: backup?.uid ?? null,
    backupGid: backup?.gid ?? null,
    backupGatewayMode: backup?.gatewayMode ?? null,
    clobberedPath: params.clobberedPath ?? null,
    restoredFromBackup: params.restoredFromBackup ?? false,
    restoredBackupPath: params.restoredBackupPath ?? null,
    restoreErrorCode: params.restoreErrorCode ?? null,
    restoreErrorMessage: params.restoreErrorMessage ?? null,
  };
}

type ConfigObserveAuditRecord = Omit<
  ReturnType<typeof createConfigObserveAuditRecord>,
  "hash" | "bytes"
> & { hash: string | null; bytes: number | null };

export type ConfigAuditRecord =
  | ConfigWriteAuditRecord
  | ConfigObserveAuditRecord
  | ConfigExternalChangeAuditRecord;

type ConfigAuditStatMetadata = {
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
};

type ConfigAuditProcessInfo = {
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
};

function normalizeAuditLabel(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveConfigAuditProcessInfo(
  processInfo?: ConfigAuditProcessInfo,
): ConfigAuditProcessInfo {
  if (processInfo) {
    return {
      ...processInfo,
      argv: redactConfigAuditArgv(capArgv(processInfo.argv)),
      execArgv: redactConfigAuditArgv(capArgv(processInfo.execArgv)),
    };
  }
  return snapshotConfigAuditProcessInfo();
}

export function resolveLegacyConfigAuditLogPath(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  return path.join(resolveStateDir(env, homedir), "logs", LEGACY_CONFIG_AUDIT_LOG_FILENAME);
}

export function formatConfigOverwriteLogMessage(params: {
  configPath: string;
  previousHash: string | null;
  nextHash: string;
  changedPathCount?: number;
}): string {
  const changeSummary =
    typeof params.changedPathCount === "number" ? `, changedPaths=${params.changedPathCount}` : "";
  return `Config overwrite: ${params.configPath} (sha256 ${params.previousHash ?? "unknown"} -> ${params.nextHash}, backup=${params.configPath}.bak${changeSummary})`;
}

export function createConfigWriteAuditRecordBase(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  existsBefore: boolean;
  previousHash: string | null;
  nextHash: string;
  previousBytes: number | null;
  nextBytes: number;
  previousMetadata: ConfigAuditStatMetadata;
  changedPathCount: number | null | undefined;
  changedPaths?: readonly string[];
  origin?: ConfigWriteAuditOrigin;
  hasMetaBefore: boolean;
  hasMetaAfter: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
  suspicious: string[];
  now?: string;
  processInfo?: ConfigAuditProcessInfo;
}) {
  const processSnapshot = resolveConfigAuditProcessInfo(params.processInfo);
  return {
    ts: params.now ?? new Date().toISOString(),
    source: "config-io" as const,
    event: "config.write" as const,
    configPath: params.configPath,
    pid: processSnapshot.pid,
    ppid: processSnapshot.ppid,
    cwd: processSnapshot.cwd,
    argv: processSnapshot.argv,
    execArgv: processSnapshot.execArgv,
    watchMode: params.env.OPENCLAW_WATCH_MODE === "1",
    watchSession: normalizeAuditLabel(params.env.OPENCLAW_WATCH_SESSION),
    watchCommand: normalizeAuditLabel(params.env.OPENCLAW_WATCH_COMMAND),
    existsBefore: params.existsBefore,
    previousHash: params.previousHash,
    nextHash: params.nextHash,
    previousBytes: params.previousBytes,
    nextBytes: params.nextBytes,
    previousDev: params.previousMetadata.dev,
    previousIno: params.previousMetadata.ino,
    previousMode: params.previousMetadata.mode,
    previousNlink: params.previousMetadata.nlink,
    previousUid: params.previousMetadata.uid,
    previousGid: params.previousMetadata.gid,
    changedPathCount: typeof params.changedPathCount === "number" ? params.changedPathCount : null,
    ...(params.changedPaths ? { changedPaths: capConfigAuditPaths(params.changedPaths) } : {}),
    ...(params.origin ? { origin: params.origin } : {}),
    hasMetaBefore: params.hasMetaBefore,
    hasMetaAfter: params.hasMetaAfter,
    gatewayModeBefore: params.gatewayModeBefore,
    gatewayModeAfter: params.gatewayModeAfter,
    suspicious: params.suspicious,
  };
}

type ConfigWriteAuditRecordBase = ReturnType<typeof createConfigWriteAuditRecordBase>;

function capConfigAuditEntries(values: readonly string[], cap: number): string[] {
  if (values.length <= cap) {
    return [...values];
  }
  const visibleCount = Math.max(0, cap - 1);
  return [...values.slice(0, visibleCount), `…+${values.length - visibleCount} more`];
}

export function capConfigAuditPaths(paths: readonly string[]): string[] {
  return capConfigAuditEntries([...new Set(paths)].toSorted(), CONFIG_AUDIT_PATH_CAP);
}

export function capConfigAuditIssues(issues: readonly string[]): string[] {
  return capConfigAuditEntries(issues, CONFIG_AUDIT_ISSUE_CAP);
}

export function finalizeConfigWriteAuditRecord(params: {
  base: ConfigWriteAuditRecordBase;
  result: ConfigWriteAuditResult;
  nextMetadata?: ConfigAuditStatMetadata | null;
  err?: unknown;
}) {
  const errorCode =
    params.err &&
    typeof params.err === "object" &&
    "code" in params.err &&
    typeof params.err.code === "string"
      ? params.err.code
      : undefined;
  const errorMessage =
    params.err &&
    typeof params.err === "object" &&
    "message" in params.err &&
    typeof params.err.message === "string"
      ? params.err.message
      : undefined;
  const nextMetadata = params.nextMetadata ?? {
    dev: null,
    ino: null,
    mode: null,
    nlink: null,
    uid: null,
    gid: null,
  };
  const success = params.result !== "failed" && params.result !== "rejected";
  return {
    ...params.base,
    result: params.result,
    nextHash: success ? params.base.nextHash : null,
    nextBytes: success ? params.base.nextBytes : null,
    nextDev: success ? nextMetadata.dev : null,
    nextIno: success ? nextMetadata.ino : null,
    nextMode: success ? nextMetadata.mode : null,
    nextNlink: success ? nextMetadata.nlink : null,
    nextUid: success ? nextMetadata.uid : null,
    nextGid: success ? nextMetadata.gid : null,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

type ConfigWriteAuditRecord = ReturnType<typeof finalizeConfigWriteAuditRecord>;

type ConfigAuditAppendContext = {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
};

type ConfigAuditAppendParams = ConfigAuditAppendContext &
  (
    | {
        record: ConfigAuditRecord;
      }
    | ConfigAuditRecord
  );

function resolveConfigAuditAppendRecord(params: ConfigAuditAppendParams): ConfigAuditRecord {
  if ("record" in params) {
    return params.record;
  }
  const { env: _env, homedir: _homedir, ...record } = params;
  return record as ConfigAuditRecord;
}

export type ConfigAuditScrubResult = {
  scanned: number;
  rewritten: number;
  skipped: number;
  // True when the scrub detected concurrent appends mid-rewrite and refused
  // to swap the file. Caller should re-run `openclaw doctor --fix` once the
  // gateway is idle. No on-disk content was modified on abort.
  aborted: boolean;
};

type ConfigAuditScrubFs = {
  promises: {
    readFile(path: string, encoding: "utf-8"): Promise<string>;
    stat(path: string): Promise<{ size: number }>;
    writeFile(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number },
    ): Promise<unknown>;
    rename(oldPath: string, newPath: string): Promise<unknown>;
    unlink(path: string): Promise<unknown>;
  };
};

// Rewrites every record in `config-audit.jsonl` through `redactConfigAuditArgv`
// so that historical argv/execArgv values written before the forward redactor
// shipped are masked the same way new entries are. Idempotent — re-applying the
// redactor to already-masked entries is a no-op because the redactor passes
// `***` and `--flag=***` through unchanged, so subsequent doctor passes do not
// rewrite the file unless a genuinely unredacted entry is still present.
// Malformed lines (parse failures, non-object payloads) are preserved verbatim
// and counted as `skipped` so the function never destroys forensic content it
// cannot understand.
// Atomic write: produces a sibling `*.scrub.tmp` file at mode `0o600`, then
// renames it over the audit log. The temp file is unlinked on any error path
// so a partial scrub never leaves plaintext at rest.
export async function scrubConfigAuditLog(params: {
  fs: ConfigAuditScrubFs;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  dryRun?: boolean;
}): Promise<ConfigAuditScrubResult> {
  const auditPath = resolveLegacyConfigAuditLogPath(params.env, params.homedir);
  let raw: string;
  try {
    raw = await params.fs.promises.readFile(auditPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { scanned: 0, rewritten: 0, skipped: 0, aborted: false };
    }
    throw err;
  }
  const originalByteLength = Buffer.byteLength(raw, "utf-8");

  let scanned = 0;
  let rewritten = 0;
  let skipped = 0;
  let changed = false;
  const outLines: string[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    if (line.length === 0) {
      outLines.push(line);
      continue;
    }
    scanned += 1;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      outLines.push(line);
      skipped += 1;
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      outLines.push(line);
      skipped += 1;
      continue;
    }
    const obj = record as Record<string, unknown>;
    let mutated = false;
    for (const key of ["argv", "execArgv"] as const) {
      const value = obj[key];
      if (!Array.isArray(value)) {
        continue;
      }
      if (!value.every((entry): entry is string => typeof entry === "string")) {
        continue;
      }
      const redacted = redactConfigAuditArgv(value);
      let differs = false;
      for (let i = 0; i < redacted.length; i++) {
        if (redacted[i] !== value[i]) {
          differs = true;
          break;
        }
      }
      if (differs) {
        obj[key] = redacted;
        mutated = true;
      }
    }
    if (mutated) {
      rewritten += 1;
      changed = true;
      outLines.push(JSON.stringify(obj));
    } else {
      outLines.push(line);
    }
  }

  if (!changed || params.dryRun) {
    return { scanned, rewritten, skipped, aborted: false };
  }

  // Concurrent-append guard: re-stat just before the rename. If the file
  // grew while the scrub was transforming records in memory, an
  // appendConfigAuditRecord caller wrote a new entry that the rename would
  // overwrite. Abort instead of silently dropping the new record. The
  // caller (doctor --fix) surfaces a retry hint to the operator.
  let preRenameSize: number;
  try {
    preRenameSize = (await params.fs.promises.stat(auditPath)).size;
  } catch {
    return { scanned, rewritten, skipped, aborted: true };
  }
  if (preRenameSize !== originalByteLength) {
    return { scanned, rewritten, skipped, aborted: true };
  }

  const tmpPath = `${auditPath}.scrub.tmp`;
  try {
    await params.fs.promises.writeFile(tmpPath, outLines.join("\n"), {
      encoding: "utf-8",
      mode: 0o600,
    });
    let finalPreRenameSize: number;
    try {
      finalPreRenameSize = (await params.fs.promises.stat(auditPath)).size;
    } catch {
      try {
        await params.fs.promises.unlink(tmpPath);
      } catch {
        // best-effort cleanup; the stat failure is handled as a safe abort
      }
      return { scanned, rewritten, skipped, aborted: true };
    }
    if (finalPreRenameSize !== originalByteLength) {
      try {
        await params.fs.promises.unlink(tmpPath);
      } catch {
        // best-effort cleanup; the append detection is the actionable state
      }
      return { scanned, rewritten, skipped, aborted: true };
    }
    await params.fs.promises.rename(tmpPath, auditPath);
  } catch (err) {
    try {
      await params.fs.promises.unlink(tmpPath);
    } catch {
      // best-effort cleanup; the rename failure is the actionable error
    }
    throw err;
  }

  return { scanned, rewritten, skipped, aborted: false };
}

function openConfigAuditStore(env: NodeJS.ProcessEnv) {
  return createSqliteAuditRecordStore<ConfigAuditRecord>({
    scope: CONFIG_AUDIT_SCOPE,
    maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
    env,
  });
}

/** Reads a bounded newest-first audit window for Doctor provenance checks. */
export function readRecentConfigAuditRecords(params: {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  limit: number;
}): ConfigAuditRecord[] {
  try {
    return openConfigAuditStore(resolveConfigAuditStoreEnv(params))
      .latest({ limit: params.limit })
      .map(({ value }) => value);
  } catch {
    return [];
  }
}

function configAuditEntryKey(record: ConfigAuditRecord): string {
  return `${record.ts}:${record.event}:${randomUUID()}`;
}

export function sanitizeConfigAuditRecord(record: ConfigAuditRecord): ConfigAuditRecord {
  const sanitized = structuredClone(record);
  if (sanitized.event !== "config.external") {
    sanitized.argv = redactConfigAuditArgv(capArgv(sanitized.argv));
    sanitized.execArgv = redactConfigAuditArgv(capArgv(sanitized.execArgv));
  }
  return redactSecrets(sanitized);
}

export async function appendConfigAuditRecord(
  params: ConfigAuditAppendParams,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  try {
    const record = sanitizeConfigAuditRecord(resolveConfigAuditAppendRecord(params));
    await registerSqliteAuditRecordAsync(
      {
        scope: CONFIG_AUDIT_SCOPE,
        maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
        env: resolveConfigAuditStoreEnv(params),
        assertCurrent,
      },
      { key: configAuditEntryKey(record), value: record, createdAt: Date.parse(record.ts) },
    );
  } catch {
    assertCurrent?.();
    // best-effort
  }
}

export function appendConfigAuditRecordSync(params: ConfigAuditAppendParams): void {
  try {
    const record = sanitizeConfigAuditRecord(resolveConfigAuditAppendRecord(params));
    openConfigAuditStore(resolveConfigAuditStoreEnv(params)).register(
      configAuditEntryKey(record),
      record,
      Date.parse(record.ts),
    );
  } catch {
    // best-effort
  }
}

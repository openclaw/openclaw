import crypto from "node:crypto";
import path from "node:path";
import { isRecord } from "../utils.js";
import { CONFIG_BACKUP_COUNT } from "./backup-rotation.js";
import {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  type ConfigObserveAuditRecord,
} from "./io.audit.js";
import { resolveStateDir } from "./paths.js";

export type ObserveRecoveryDeps = {
  fs: {
    promises: {
      stat(path: string): Promise<{
        mtimeMs?: number;
        ctimeMs?: number;
        dev?: number | bigint;
        ino?: number | bigint;
        mode?: number;
        nlink?: number;
        uid?: number;
        gid?: number;
      } | null>;
      readFile(path: string, encoding: BufferEncoding): Promise<string>;
      writeFile(
        path: string,
        data: string,
        options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
      ): Promise<unknown>;
      copyFile(src: string, dest: string): Promise<unknown>;
      mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
      appendFile(
        path: string,
        data: string,
        options?: { encoding?: BufferEncoding; mode?: number },
      ): Promise<unknown>;
    };
    statSync(
      path: string,
      options?: { throwIfNoEntry?: boolean },
    ): {
      mtimeMs?: number;
      ctimeMs?: number;
      dev?: number | bigint;
      ino?: number | bigint;
      mode?: number;
      nlink?: number;
      uid?: number;
      gid?: number;
    } | null;
    lstatSync(
      path: string,
      options?: { throwIfNoEntry?: boolean },
    ): {
      mode?: number;
    } | null;
    readFileSync(path: string, encoding: BufferEncoding): string;
    writeFileSync(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
    ): unknown;
    copyFileSync(src: string, dest: string): unknown;
    mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown;
    appendFileSync(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number },
    ): unknown;
  };
  json5: { parse(value: string): unknown };
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  logger: Pick<typeof console, "warn">;
};

type ObserveSnapshot = {
  path: string;
  exists: boolean;
  valid: boolean;
  raw: string | null;
  hash?: string;
  parsed: unknown;
  resolved?: unknown;
};

type ConfigHealthFingerprint = {
  hash: string;
  bytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  observedAt: string;
};

type ConfigStatMetadataSource =
  | ({
      mtimeMs?: number;
      ctimeMs?: number;
      dev?: number | bigint;
      ino?: number | bigint;
      mode?: number;
      nlink?: number;
      uid?: number;
      gid?: number;
    } & Record<string, unknown>)
  | null;

type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
};

function createConfigObserveAuditRecord(params: {
  ts: string;
  configPath: string;
  valid: boolean;
  current: ConfigHealthFingerprint;
  suspicious: string[];
  lastKnownGood: ConfigHealthFingerprint | undefined;
  backup: ConfigHealthFingerprint | null | undefined;
  clobberedPath: string | null;
  restoredFromBackup: boolean;
  restoredBackupPath: string | null;
}): ConfigObserveAuditRecord {
  return {
    ts: params.ts,
    source: "config-io",
    event: "config.observe",
    phase: "read",
    configPath: params.configPath,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 8),
    execArgv: process.execArgv.slice(0, 8),
    exists: true,
    valid: params.valid,
    hash: params.current.hash,
    bytes: params.current.bytes,
    mtimeMs: params.current.mtimeMs,
    ctimeMs: params.current.ctimeMs,
    dev: params.current.dev,
    ino: params.current.ino,
    mode: params.current.mode,
    nlink: params.current.nlink,
    uid: params.current.uid,
    gid: params.current.gid,
    hasMeta: params.current.hasMeta,
    gatewayMode: params.current.gatewayMode,
    suspicious: params.suspicious,
    lastKnownGoodHash: params.lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: params.lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: params.lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: params.lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: params.lastKnownGood?.dev ?? null,
    lastKnownGoodIno: params.lastKnownGood?.ino ?? null,
    lastKnownGoodMode: params.lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: params.lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: params.lastKnownGood?.uid ?? null,
    lastKnownGoodGid: params.lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: params.lastKnownGood?.gatewayMode ?? null,
    backupHash: params.backup?.hash ?? null,
    backupBytes: params.backup?.bytes ?? null,
    backupMtimeMs: params.backup?.mtimeMs ?? null,
    backupCtimeMs: params.backup?.ctimeMs ?? null,
    backupDev: params.backup?.dev ?? null,
    backupIno: params.backup?.ino ?? null,
    backupMode: params.backup?.mode ?? null,
    backupNlink: params.backup?.nlink ?? null,
    backupUid: params.backup?.uid ?? null,
    backupGid: params.backup?.gid ?? null,
    backupGatewayMode: params.backup?.gatewayMode ?? null,
    clobberedPath: params.clobberedPath,
    restoredFromBackup: params.restoredFromBackup,
    restoredBackupPath: params.restoredBackupPath,
  };
}

type ConfigObserveAuditRecordParams = Parameters<typeof createConfigObserveAuditRecord>[0];

function createConfigObserveAuditAppendParams(
  deps: ObserveRecoveryDeps,
  params: ConfigObserveAuditRecordParams,
) {
  return {
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    record: createConfigObserveAuditRecord(params),
  };
}

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null {
  if (typeof snapshot.hash === "string") {
    const trimmed = snapshot.hash.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof snapshot.raw !== "string") {
    return null;
  }
  return hashConfigRaw(snapshot.raw);
}

function hasConfigMeta(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    (typeof value.meta.lastTouchedVersion === "string" ||
      typeof value.meta.lastTouchedAt === "string")
  );
}

function resolveGatewayMode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.gateway)) {
    return null;
  }
  return typeof value.gateway.mode === "string" ? value.gateway.mode : null;
}

function resolveConfigStatMetadata(stat: ConfigStatMetadataSource): {
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
} {
  if (!stat) {
    return {
      dev: null,
      ino: null,
      mode: null,
      nlink: null,
      uid: null,
      gid: null,
    };
  }
  return {
    dev: typeof stat.dev === "number" || typeof stat.dev === "bigint" ? String(stat.dev) : null,
    ino: typeof stat.ino === "number" || typeof stat.ino === "bigint" ? String(stat.ino) : null,
    mode: typeof stat.mode === "number" ? stat.mode : null,
    nlink: typeof stat.nlink === "number" ? stat.nlink : null,
    uid: typeof stat.uid === "number" ? stat.uid : null,
    gid: typeof stat.gid === "number" ? stat.gid : null,
  };
}

function createConfigHealthFingerprint(params: {
  hash: string;
  raw: string;
  parsed: unknown;
  gatewaySource: unknown;
  stat: ConfigStatMetadataSource;
  observedAt: string;
}): ConfigHealthFingerprint {
  return {
    hash: params.hash,
    bytes: Buffer.byteLength(params.raw, "utf-8"),
    mtimeMs: params.stat?.mtimeMs ?? null,
    ctimeMs: params.stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(params.stat),
    hasMeta: hasConfigMeta(params.parsed),
    gatewayMode: resolveGatewayMode(params.gatewaySource),
    observedAt: params.observedAt,
  };
}

function resolveConfigHealthStatePath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveStateDir(env, homedir), "logs", "config-health.json");
}

async function readConfigHealthState(deps: ObserveRecoveryDeps): Promise<ConfigHealthState> {
  try {
    const raw = await deps.fs.promises.readFile(
      resolveConfigHealthStatePath(deps.env, deps.homedir),
      "utf-8",
    );
    const parsed = deps.json5.parse(raw);
    return isRecord(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

function readConfigHealthStateSync(deps: ObserveRecoveryDeps): ConfigHealthState {
  try {
    const raw = deps.fs.readFileSync(resolveConfigHealthStatePath(deps.env, deps.homedir), "utf-8");
    const parsed = deps.json5.parse(raw);
    return isRecord(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

async function writeConfigHealthState(
  deps: ObserveRecoveryDeps,
  state: ConfigHealthState,
): Promise<void> {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    await deps.fs.promises.mkdir(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    await deps.fs.promises.writeFile(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {}
}

function writeConfigHealthStateSync(deps: ObserveRecoveryDeps, state: ConfigHealthState): void {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    deps.fs.mkdirSync(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    deps.fs.writeFileSync(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {}
}

function getConfigHealthEntry(state: ConfigHealthState, configPath: string): ConfigHealthEntry {
  const entries = state.entries;
  if (!entries || !isRecord(entries)) {
    return {};
  }
  const entry = entries[configPath];
  return entry && isRecord(entry) ? entry : {};
}

function setConfigHealthEntry(
  state: ConfigHealthState,
  configPath: string,
  entry: ConfigHealthEntry,
): ConfigHealthState {
  return {
    ...state,
    entries: {
      ...state.entries,
      [configPath]: entry,
    },
  };
}

function isUpdateChannelOnlyRoot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "update") {
    return false;
  }
  const update = value.update;
  if (!isRecord(update)) {
    return false;
  }
  const updateKeys = Object.keys(update);
  return updateKeys.length === 1 && typeof update.channel === "string";
}

function resolveConfigObserveSuspiciousReasons(params: {
  bytes: number;
  hasMeta: boolean;
  gatewayMode: string | null;
  parsed: unknown;
  lastKnownGood?: ConfigHealthFingerprint;
}): string[] {
  const reasons: string[] = [];
  const baseline = params.lastKnownGood;
  if (!baseline) {
    return reasons;
  }
  if (baseline.bytes >= 512 && params.bytes < Math.floor(baseline.bytes * 0.5)) {
    reasons.push(`size-drop-vs-last-good:${baseline.bytes}->${params.bytes}`);
  }
  if (baseline.hasMeta && !params.hasMeta) {
    reasons.push("missing-meta-vs-last-good");
  }
  if (baseline.gatewayMode && !params.gatewayMode) {
    reasons.push("gateway-mode-missing-vs-last-good");
  }
  if (baseline.gatewayMode && isUpdateChannelOnlyRoot(params.parsed)) {
    reasons.push("update-channel-only-root");
  }
  return reasons;
}

async function readConfigFingerprintForPath(
  deps: ObserveRecoveryDeps,
  targetPath: string,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(targetPath, "utf-8");
    const stat = await deps.fs.promises.stat(targetPath).catch(() => null);
    let parsed: unknown = {};
    try {
      parsed = deps.json5.parse(raw);
    } catch {}
    return {
      hash: hashConfigRaw(raw),
      bytes: Buffer.byteLength(raw, "utf-8"),
      mtimeMs: stat?.mtimeMs ?? null,
      ctimeMs: stat?.ctimeMs ?? null,
      ...resolveConfigStatMetadata(stat as Record<string, unknown> | null),
      hasMeta: hasConfigMeta(parsed),
      gatewayMode: resolveGatewayMode(parsed),
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function readConfigFingerprintForPathSync(
  deps: ObserveRecoveryDeps,
  targetPath: string,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(targetPath, "utf-8");
    const stat = deps.fs.statSync(targetPath, { throwIfNoEntry: false }) ?? null;
    let parsed: unknown = {};
    try {
      parsed = deps.json5.parse(raw);
    } catch {}
    return {
      hash: hashConfigRaw(raw),
      bytes: Buffer.byteLength(raw, "utf-8"),
      mtimeMs: stat?.mtimeMs ?? null,
      ctimeMs: stat?.ctimeMs ?? null,
      ...resolveConfigStatMetadata(stat),
      hasMeta: hasConfigMeta(parsed),
      gatewayMode: resolveGatewayMode(parsed),
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function formatConfigArtifactTimestamp(ts: string): string {
  return ts.replaceAll(":", "-").replaceAll(".", "-");
}

async function persistClobberedConfigSnapshot(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  observedAt: string;
}): Promise<string | null> {
  const targetPath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
  try {
    await params.deps.fs.promises.writeFile(targetPath, params.raw, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return targetPath;
  } catch {
    return null;
  }
}

function persistClobberedConfigSnapshotSync(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  observedAt: string;
}): string | null {
  const targetPath = `${params.configPath}.clobbered.${formatConfigArtifactTimestamp(params.observedAt)}`;
  try {
    params.deps.fs.writeFileSync(targetPath, params.raw, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return targetPath;
  } catch {
    return null;
  }
}

export async function maybeRecoverSuspiciousConfigRead(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  parsed: unknown;
}): Promise<{ raw: string; parsed: unknown }> {
  const stat = await params.deps.fs.promises.stat(params.configPath).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: hashConfigRaw(params.raw),
    raw: params.raw,
    parsed: params.parsed,
    gatewaySource: params.parsed,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });

  let healthState = await readConfigHealthState(params.deps);
  const entry = getConfigHealthEntry(healthState, params.configPath);
  const backupPath = `${params.configPath}.bak`;
  const backupBaseline =
    entry.lastKnownGood ??
    (await readConfigFingerprintForPath(params.deps, backupPath)) ??
    undefined;
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: params.parsed,
    lastKnownGood: backupBaseline,
  });
  if (!suspicious.includes("update-channel-only-root")) {
    return { raw: params.raw, parsed: params.parsed };
  }

  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return { raw: params.raw, parsed: params.parsed };
  }

  const backupRaw = await params.deps.fs.promises.readFile(backupPath, "utf-8").catch(() => null);
  if (!backupRaw) {
    return { raw: params.raw, parsed: params.parsed };
  }
  let backupParsed: unknown;
  try {
    backupParsed = params.deps.json5.parse(backupRaw);
  } catch {
    return { raw: params.raw, parsed: params.parsed };
  }
  const backup = backupBaseline ?? (await readConfigFingerprintForPath(params.deps, backupPath));
  if (!backup?.gatewayMode) {
    return { raw: params.raw, parsed: params.parsed };
  }

  const clobberedPath = await persistClobberedConfigSnapshot({
    deps: params.deps,
    configPath: params.configPath,
    raw: params.raw,
    observedAt: now,
  });

  let restoredFromBackup = false;
  try {
    await params.deps.fs.promises.copyFile(backupPath, params.configPath);
    restoredFromBackup = true;
  } catch {}

  params.deps.logger.warn(
    `Config auto-restored from backup: ${params.configPath} (${suspicious.join(", ")})`,
  );
  await appendConfigAuditRecord(
    createConfigObserveAuditAppendParams(params.deps, {
      ts: now,
      configPath: params.configPath,
      valid: true,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
      clobberedPath,
      restoredFromBackup,
      restoredBackupPath: backupPath,
    }),
  );

  healthState = setConfigHealthEntry(healthState, params.configPath, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  await writeConfigHealthState(params.deps, healthState);
  return { raw: backupRaw, parsed: backupParsed };
}

export function maybeRecoverSuspiciousConfigReadSync(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  parsed: unknown;
}): { raw: string; parsed: unknown } {
  const stat = params.deps.fs.statSync(params.configPath, { throwIfNoEntry: false }) ?? null;
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: hashConfigRaw(params.raw),
    raw: params.raw,
    parsed: params.parsed,
    gatewaySource: params.parsed,
    stat,
    observedAt: now,
  });

  let healthState = readConfigHealthStateSync(params.deps);
  const entry = getConfigHealthEntry(healthState, params.configPath);
  const backupPath = `${params.configPath}.bak`;
  const backupBaseline =
    entry.lastKnownGood ?? readConfigFingerprintForPathSync(params.deps, backupPath) ?? undefined;
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: params.parsed,
    lastKnownGood: backupBaseline,
  });
  if (!suspicious.includes("update-channel-only-root")) {
    return { raw: params.raw, parsed: params.parsed };
  }

  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return { raw: params.raw, parsed: params.parsed };
  }

  let backupRaw: string;
  try {
    backupRaw = params.deps.fs.readFileSync(backupPath, "utf-8");
  } catch {
    return { raw: params.raw, parsed: params.parsed };
  }
  let backupParsed: unknown;
  try {
    backupParsed = params.deps.json5.parse(backupRaw);
  } catch {
    return { raw: params.raw, parsed: params.parsed };
  }
  const backup = backupBaseline ?? readConfigFingerprintForPathSync(params.deps, backupPath);
  if (!backup?.gatewayMode) {
    return { raw: params.raw, parsed: params.parsed };
  }

  const clobberedPath = persistClobberedConfigSnapshotSync({
    deps: params.deps,
    configPath: params.configPath,
    raw: params.raw,
    observedAt: now,
  });

  let restoredFromBackup = false;
  try {
    params.deps.fs.copyFileSync(backupPath, params.configPath);
    restoredFromBackup = true;
  } catch {}

  params.deps.logger.warn(
    `Config auto-restored from backup: ${params.configPath} (${suspicious.join(", ")})`,
  );
  appendConfigAuditRecordSync(
    createConfigObserveAuditAppendParams(params.deps, {
      ts: now,
      configPath: params.configPath,
      valid: true,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
      clobberedPath,
      restoredFromBackup,
      restoredBackupPath: backupPath,
    }),
  );

  healthState = setConfigHealthEntry(healthState, params.configPath, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  writeConfigHealthStateSync(params.deps, healthState);
  return { raw: backupRaw, parsed: backupParsed };
}

/**
 * Callback type for schema validation used by the schema-invalid recovery path.
 * Receives the parsed (but not yet validated) config object and returns true
 * if it passes schema validation.
 */
export type SchemaValidateFn = (parsed: unknown) => boolean;

/**
 * Maximum byte length accepted when reading a backup candidate during schema
 * recovery. Files larger than this are skipped rather than parsed. 10 MB is
 * well above any realistic OpenClaw config file and caps memory/CPU exposure
 * from attacker-controlled file content (CWE-400).
 */
const RECOVERY_MAX_BYTES = 10 * 1024 * 1024;

/** Bitmask for the file-type portion of a POSIX mode word. */
const S_IFMT = 0o170000;
/** File-type value for a symbolic link. */
const S_IFLNK = 0o120000;

function isSymlink(mode: number | undefined): boolean {
  return mode !== undefined && (mode & S_IFMT) === S_IFLNK;
}

/**
 * Attempts to recover from a schema-invalid config file by scanning the backup
 * rotation ring for the most-recent schema-valid snapshot and restoring it.
 *
 * This is the recovery path for the direct-write attack vector: an agent with
 * `tools.exec` capability can write an invalid config directly to the config
 * file path, bypassing all validated write paths. The existing
 * `maybeRecoverSuspiciousConfigReadSync` only handles the `update-channel-only-root`
 * heuristic and does not detect schema violations; `loadConfig` would then
 * hard-fail with INVALID_CONFIG and leave OpenClaw permanently bricked.
 *
 * Returns `true` if a valid backup was found and restored; `false` otherwise.
 * The corrupted config file is archived as a `.clobbered.*` snapshot before
 * being overwritten, so it is available for forensic analysis.
 *
 * Validation note: backups are validated with `validateConfigObjectRawWithPlugins`
 * (raw, without applying defaults or include-expansion). This is intentional:
 * all backups are produced by `writeConfigFile` which already expands includes
 * before writing, so persisted backups never contain raw `$include` directives.
 * Using the raw validator avoids re-running include I/O during recovery.
 */
export function maybeRecoverFromSchemaInvalidConfigSync(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  validate: SchemaValidateFn;
}): boolean {
  const { deps, configPath, validate } = params;

  // Safety: refuse to overwrite through a symlink at the primary config path.
  // If configPath is a symlink, copyFileSync would follow it and write to an
  // attacker-controlled target (CWE-59 / TOCTOU). Abort recovery entirely.
  try {
    const configLstat = deps.fs.lstatSync(configPath, { throwIfNoEntry: false });
    if (configLstat !== null && isSymlink(configLstat.mode)) {
      return false;
    }
  } catch {
    // lstat unavailable or unexpected error — abort recovery to stay safe.
    return false;
  }

  // Read the corrupted file once for the forensic archive. We do this before
  // the candidate loop so we only archive it once regardless of how many
  // candidates we try (CWE-400 / duplicate archive fix).
  let invalidRaw: string | null = null;
  try {
    invalidRaw = deps.fs.readFileSync(configPath, "utf-8");
  } catch {
    // Primary file unreadable — proceed to backup scan without archiving.
  }

  // Scan the backup rotation ring: .bak, .bak.1, .bak.2, …, .bak.{N-1}
  const backupBase = `${configPath}.bak`;
  const candidatePaths: string[] = [backupBase];
  for (let i = 1; i < CONFIG_BACKUP_COUNT; i++) {
    candidatePaths.push(`${backupBase}.${i}`);
  }

  // Track whether the corrupted file has already been archived so we write the
  // .clobbered snapshot exactly once even if we loop through multiple candidates.
  let invalidArchived = false;

  for (const candidatePath of candidatePaths) {
    // Safety: refuse to read through a symlink in the backup ring.
    // An attacker could plant a symlink at a .bak path to exfiltrate or poison
    // data from elsewhere on the filesystem (CWE-59).
    try {
      const candidateLstat = deps.fs.lstatSync(candidatePath, { throwIfNoEntry: false });
      if (candidateLstat === null) {
        continue; // file does not exist — try next slot
      }
      if (isSymlink(candidateLstat.mode)) {
        continue; // symlink — skip this slot
      }
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = deps.fs.readFileSync(candidatePath, "utf-8");
    } catch {
      continue;
    }

    // Guard against attacker-inflated backup files causing memory/CPU exhaustion
    // during JSON5 parsing (CWE-400).
    if (Buffer.byteLength(raw, "utf-8") > RECOVERY_MAX_BYTES) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = deps.json5.parse(raw);
    } catch {
      continue;
    }

    if (!validate(parsed)) {
      continue;
    }

    // Found a schema-valid backup. Archive the corrupted config exactly once
    // before the first restore attempt.
    if (invalidRaw !== null && !invalidArchived) {
      invalidArchived = true;
      persistClobberedConfigSnapshotSync({
        deps,
        configPath,
        raw: invalidRaw,
        observedAt: new Date().toISOString(),
      });
    }

    try {
      deps.fs.copyFileSync(candidatePath, configPath);
    } catch {
      // Copy failed — skip to next candidate without marking as restored.
      continue;
    }

    deps.logger.warn(
      `Config schema-invalid; auto-restored from backup: ${configPath} <- ${candidatePath}`,
    );
    return true;
  }

  return false;
}

export async function observeConfigSnapshot(
  deps: ObserveRecoveryDeps,
  snapshot: ObserveSnapshot,
): Promise<void> {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }

  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    gatewaySource: snapshot.resolved,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });

  let healthState = await readConfigHealthState(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  const backupBaseline =
    entry.lastKnownGood ??
    (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`)) ??
    undefined;
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: snapshot.parsed,
    lastKnownGood: backupBaseline,
  });

  if (suspicious.length === 0) {
    if (snapshot.valid) {
      const nextEntry: ConfigHealthEntry = {
        lastKnownGood: current,
        lastObservedSuspiciousSignature: null,
      };
      const same =
        entry.lastKnownGood &&
        entry.lastKnownGood.hash === current.hash &&
        entry.lastKnownGood.bytes === current.bytes &&
        entry.lastKnownGood.mtimeMs === current.mtimeMs &&
        entry.lastKnownGood.ctimeMs === current.ctimeMs &&
        entry.lastKnownGood.dev === current.dev &&
        entry.lastKnownGood.ino === current.ino &&
        entry.lastKnownGood.mode === current.mode &&
        entry.lastKnownGood.nlink === current.nlink &&
        entry.lastKnownGood.uid === current.uid &&
        entry.lastKnownGood.gid === current.gid &&
        entry.lastKnownGood.hasMeta === current.hasMeta &&
        entry.lastKnownGood.gatewayMode === current.gatewayMode;
      if (!same || entry.lastObservedSuspiciousSignature !== null) {
        healthState = setConfigHealthEntry(healthState, snapshot.path, nextEntry);
        await writeConfigHealthState(deps, healthState);
      }
    }
    return;
  }

  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return;
  }

  const backup =
    (backupBaseline?.hash ? backupBaseline : null) ??
    (await readConfigFingerprintForPath(deps, `${snapshot.path}.bak`));
  const clobberedPath = await persistClobberedConfigSnapshot({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });

  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  await appendConfigAuditRecord(
    createConfigObserveAuditAppendParams(deps, {
      ts: now,
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
      clobberedPath,
      restoredFromBackup: false,
      restoredBackupPath: null,
    }),
  );

  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  await writeConfigHealthState(deps, healthState);
}

export function observeConfigSnapshotSync(
  deps: ObserveRecoveryDeps,
  snapshot: ObserveSnapshot,
): void {
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return;
  }

  const stat = deps.fs.statSync(snapshot.path, { throwIfNoEntry: false }) ?? null;
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    gatewaySource: snapshot.resolved,
    stat,
    observedAt: now,
  });

  let healthState = readConfigHealthStateSync(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  const backupBaseline =
    entry.lastKnownGood ??
    readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`) ??
    undefined;
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: snapshot.parsed,
    lastKnownGood: backupBaseline,
  });

  if (suspicious.length === 0) {
    if (snapshot.valid) {
      healthState = setConfigHealthEntry(healthState, snapshot.path, {
        lastKnownGood: current,
        lastObservedSuspiciousSignature: null,
      });
      writeConfigHealthStateSync(deps, healthState);
    }
    return;
  }

  const suspiciousSignature = `${current.hash}:${suspicious.join(",")}`;
  if (entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return;
  }

  const backup =
    (backupBaseline?.hash ? backupBaseline : null) ??
    readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`);
  const clobberedPath = persistClobberedConfigSnapshotSync({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });

  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  appendConfigAuditRecordSync(
    createConfigObserveAuditAppendParams(deps, {
      ts: now,
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious,
      lastKnownGood: entry.lastKnownGood,
      backup,
      clobberedPath,
      restoredFromBackup: false,
      restoredBackupPath: null,
    }),
  );

  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  writeConfigHealthStateSync(deps, healthState);
}

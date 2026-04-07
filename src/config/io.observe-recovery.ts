import crypto from "node:crypto";
import path from "node:path";
import { isRecord } from "../utils.js";
import { appendConfigAuditRecord, appendConfigAuditRecordSync } from "./io.audit.js";
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

type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
};

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

function resolveConfigStatMetadata(
  stat:
    | ({
        dev?: number | bigint;
        ino?: number | bigint;
        mode?: number;
        nlink?: number;
        uid?: number;
        gid?: number;
      } & Record<string, unknown>)
    | null,
): {
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
  const current: ConfigHealthFingerprint = {
    hash: hashConfigRaw(params.raw),
    bytes: Buffer.byteLength(params.raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat as Record<string, unknown> | null),
    hasMeta: hasConfigMeta(params.parsed),
    gatewayMode: resolveGatewayMode(params.parsed),
    observedAt: now,
  };

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
  await appendConfigAuditRecord({
    fs: params.deps.fs,
    env: params.deps.env,
    homedir: params.deps.homedir,
    ts: now,
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
    valid: true,
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
    suspicious,
    lastKnownGoodHash: entry.lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: entry.lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: entry.lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: entry.lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: entry.lastKnownGood?.dev ?? null,
    lastKnownGoodIno: entry.lastKnownGood?.ino ?? null,
    lastKnownGoodMode: entry.lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: entry.lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: entry.lastKnownGood?.uid ?? null,
    lastKnownGoodGid: entry.lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: entry.lastKnownGood?.gatewayMode ?? null,
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
    clobberedPath,
    restoredFromBackup,
    restoredBackupPath: backupPath,
  });

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
  const current: ConfigHealthFingerprint = {
    hash: hashConfigRaw(params.raw),
    bytes: Buffer.byteLength(params.raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat),
    hasMeta: hasConfigMeta(params.parsed),
    gatewayMode: resolveGatewayMode(params.parsed),
    observedAt: now,
  };

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
  appendConfigAuditRecordSync({
    fs: params.deps.fs,
    env: params.deps.env,
    homedir: params.deps.homedir,
    ts: now,
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
    valid: true,
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
    suspicious,
    lastKnownGoodHash: entry.lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: entry.lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: entry.lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: entry.lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: entry.lastKnownGood?.dev ?? null,
    lastKnownGoodIno: entry.lastKnownGood?.ino ?? null,
    lastKnownGoodMode: entry.lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: entry.lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: entry.lastKnownGood?.uid ?? null,
    lastKnownGoodGid: entry.lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: entry.lastKnownGood?.gatewayMode ?? null,
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
    clobberedPath,
    restoredFromBackup,
    restoredBackupPath: backupPath,
  });

  healthState = setConfigHealthEntry(healthState, params.configPath, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  writeConfigHealthStateSync(params.deps, healthState);
  return { raw: backupRaw, parsed: backupParsed };
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
  const current: ConfigHealthFingerprint = {
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    bytes: Buffer.byteLength(snapshot.raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat as Record<string, unknown> | null),
    hasMeta: hasConfigMeta(snapshot.parsed),
    gatewayMode: resolveGatewayMode(snapshot.resolved),
    observedAt: now,
  };

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
  await appendConfigAuditRecord({
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    ts: now,
    source: "config-io",
    event: "config.observe",
    phase: "read",
    configPath: snapshot.path,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 8),
    execArgv: process.execArgv.slice(0, 8),
    exists: true,
    valid: snapshot.valid,
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
    suspicious,
    lastKnownGoodHash: entry.lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: entry.lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: entry.lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: entry.lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: entry.lastKnownGood?.dev ?? null,
    lastKnownGoodIno: entry.lastKnownGood?.ino ?? null,
    lastKnownGoodMode: entry.lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: entry.lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: entry.lastKnownGood?.uid ?? null,
    lastKnownGoodGid: entry.lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: entry.lastKnownGood?.gatewayMode ?? null,
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
    clobberedPath,
    restoredFromBackup: false,
    restoredBackupPath: null,
  });

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
  const current: ConfigHealthFingerprint = {
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    bytes: Buffer.byteLength(snapshot.raw, "utf-8"),
    mtimeMs: stat?.mtimeMs ?? null,
    ctimeMs: stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(stat),
    hasMeta: hasConfigMeta(snapshot.parsed),
    gatewayMode: resolveGatewayMode(snapshot.resolved),
    observedAt: now,
  };

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
  appendConfigAuditRecordSync({
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    ts: now,
    source: "config-io",
    event: "config.observe",
    phase: "read",
    configPath: snapshot.path,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 8),
    execArgv: process.execArgv.slice(0, 8),
    exists: true,
    valid: snapshot.valid,
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
    suspicious,
    lastKnownGoodHash: entry.lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: entry.lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: entry.lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: entry.lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: entry.lastKnownGood?.dev ?? null,
    lastKnownGoodIno: entry.lastKnownGood?.ino ?? null,
    lastKnownGoodMode: entry.lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: entry.lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: entry.lastKnownGood?.uid ?? null,
    lastKnownGoodGid: entry.lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: entry.lastKnownGood?.gatewayMode ?? null,
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
    clobberedPath,
    restoredFromBackup: false,
    restoredBackupPath: null,
  });

  healthState = setConfigHealthEntry(healthState, snapshot.path, {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  });
  writeConfigHealthStateSync(deps, healthState);
}

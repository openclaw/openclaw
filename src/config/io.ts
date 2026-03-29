import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js";
import { loadDotEnv } from "../infra/dotenv.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { VERSION } from "../version.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import { restoreEnvVarRefs } from "./env-preserve.js";
import {
  type EnvSubstitutionWarning,
  MissingEnvVarError,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "./env-substitution.js";
import { applyConfigEnvVars } from "./env-vars.js";
import {
  ConfigIncludeError,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludes,
} from "./includes.js";
import { migrateLegacyConfig } from "./legacy-migrate.js";
import { findLegacyConfigIssues } from "./legacy.js";
import {
  asResolvedSourceConfig,
  asRuntimeConfig,
  materializeRuntimeConfig,
} from "./materialize.js";
import { applyMergePatch } from "./merge-patch.js";
import { resolveConfigPath, resolveDefaultConfigCandidates, resolveStateDir } from "./paths.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import type { OpenClawConfig, ConfigFileSnapshot, LegacyConfigIssue } from "./types.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
import { shouldWarnOnTouchedVersion } from "./version.js";

// Re-export for backwards compatibility
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";

const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "MINIMAX_API_KEY",
  "MODELSTUDIO_API_KEY",
  "SYNTHETIC_API_KEY",
  "KILOCODE_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
];

const OPEN_DM_POLICY_ALLOW_FROM_RE =
  /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;

const CONFIG_AUDIT_LOG_FILENAME = "config-audit.jsonl";
const CONFIG_HEALTH_STATE_FILENAME = "config-health.json";
const loggedInvalidConfigs = new Set<string>();

type ConfigWriteAuditResult = "rename" | "copy-fallback" | "failed";

type ConfigWriteAuditRecord = {
  ts: string;
  source: "config-io";
  event: "config.write";
  result: ConfigWriteAuditResult;
  configPath: string;
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
  watchMode: boolean;
  watchSession: string | null;
  watchCommand: string | null;
  existsBefore: boolean;
  previousHash: string | null;
  nextHash: string | null;
  previousBytes: number | null;
  nextBytes: number | null;
  previousDev: string | null;
  nextDev: string | null;
  previousIno: string | null;
  nextIno: string | null;
  previousMode: number | null;
  nextMode: number | null;
  previousNlink: number | null;
  nextNlink: number | null;
  previousUid: number | null;
  nextUid: number | null;
  previousGid: number | null;
  nextGid: number | null;
  changedPathCount: number | null;
  hasMetaBefore: boolean;
  hasMetaAfter: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
  suspicious: string[];
  errorCode?: string;
  errorMessage?: string;
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

type ConfigObserveAuditRecord = {
  ts: string;
  source: "config-io";
  event: "config.observe";
  phase: "read";
  configPath: string;
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  execArgv: string[];
  exists: boolean;
  valid: boolean;
  hash: string | null;
  bytes: number | null;
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
  suspicious: string[];
  lastKnownGoodHash: string | null;
  lastKnownGoodBytes: number | null;
  lastKnownGoodMtimeMs: number | null;
  lastKnownGoodCtimeMs: number | null;
  lastKnownGoodDev: string | null;
  lastKnownGoodIno: string | null;
  lastKnownGoodMode: number | null;
  lastKnownGoodNlink: number | null;
  lastKnownGoodUid: number | null;
  lastKnownGoodGid: number | null;
  lastKnownGoodGatewayMode: string | null;
  backupHash: string | null;
  backupBytes: number | null;
  backupMtimeMs: number | null;
  backupCtimeMs: number | null;
  backupDev: string | null;
  backupIno: string | null;
  backupMode: number | null;
  backupNlink: number | null;
  backupUid: number | null;
  backupGid: number | null;
  backupGatewayMode: string | null;
  clobberedPath: string | null;
  restoredFromBackup: boolean;
  restoredBackupPath: string | null;
};

type ConfigAuditRecord = ConfigWriteAuditRecord | ConfigObserveAuditRecord;

export type ParseConfigJson5Result = { ok: true; parsed: unknown } | { ok: false; error: string };
export type ConfigWriteOptions = {
  /**
   * Read-time env snapshot used to validate `${VAR}` restoration decisions.
   * If omitted, write falls back to current process env.
   */
  envSnapshotForRestore?: Record<string, string | undefined>;
  /**
   * Optional safety check: only use envSnapshotForRestore when writing the
   * same config file path that produced the snapshot.
   */
  expectedConfigPath?: string;
  /**
   * Paths that must be explicitly removed from the persisted file payload,
   * even if schema/default normalization reintroduces them.
   */
  unsetPaths?: string[][];
};

export type ReadConfigFileSnapshotForWriteResult = {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
};

export type RuntimeConfigSnapshotRefreshParams = {
  sourceConfig: OpenClawConfig;
};

export type RuntimeConfigSnapshotRefreshHandler = {
  refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
  clearOnRefreshFailure?: () => void;
};

export type ConfigWriteNotification = {
  configPath: string;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  persistedHash: string;
  writtenAtMs: number;
};

export class ConfigRuntimeRefreshError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigRuntimeRefreshError";
  }
}

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

async function tightenStateDirPermissionsIfNeeded(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  fsModule: typeof fs;
}): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const stateDir = resolveStateDir(params.env, params.homedir);
  const configDir = path.dirname(params.configPath);
  if (path.resolve(configDir) !== path.resolve(stateDir)) {
    return;
  }
  try {
    const stat = await params.fsModule.promises.stat(configDir);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) === 0) {
      return;
    }
    await params.fsModule.promises.chmod(configDir, 0o700);
  } catch {
    // Best-effort hardening only; callers still need the config write to proceed.
  }
}

function formatConfigValidationFailure(pathLabel: string, issueMessage: string): string {
  const match = issueMessage.match(OPEN_DM_POLICY_ALLOW_FROM_RE);
  const policyPath = match?.groups?.policyPath?.trim();
  const allowPath = match?.groups?.allowPath?.trim();
  if (!policyPath || !allowPath) {
    return `Config validation failed: ${pathLabel}: ${issueMessage}`;
  }

  return [
    `Config validation failed: ${pathLabel}`,
    "",
    `Configuration mismatch: ${policyPath} is "open", but ${allowPath} does not include "*".`,
    "",
    "Fix with:",
    `  openclaw config set ${allowPath} '["*"]'`,
    "",
    "Or switch policy:",
    `  openclaw config set ${policyPath} "pairing"`,
  ].join("\n");
}

function isNumericPathSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

function isWritePlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnObjectKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object");

type UnsetPathWriteResult = {
  changed: boolean;
  value: unknown;
};

function unsetPathForWriteAt(
  value: unknown,
  pathSegments: string[],
  depth: number,
): UnsetPathWriteResult {
  if (depth >= pathSegments.length) {
    return { changed: false, value };
  }
  const segment = pathSegments[depth];
  const isLeaf = depth === pathSegments.length - 1;

  if (Array.isArray(value)) {
    if (!isNumericPathSegment(segment)) {
      return { changed: false, value };
    }
    const index = Number.parseInt(segment, 10);
    if (!Number.isFinite(index) || index < 0 || index >= value.length) {
      return { changed: false, value };
    }
    if (isLeaf) {
      const next = value.slice();
      next.splice(index, 1);
      return { changed: true, value: next };
    }
    const child = unsetPathForWriteAt(value[index], pathSegments, depth + 1);
    if (!child.changed) {
      return { changed: false, value };
    }
    const next = value.slice();
    if (child.value === WRITE_PRUNED_OBJECT) {
      next.splice(index, 1);
    } else {
      next[index] = child.value;
    }
    return { changed: true, value: next };
  }

  if (
    isBlockedObjectKey(segment) ||
    !isWritePlainObject(value) ||
    !hasOwnObjectKey(value, segment)
  ) {
    return { changed: false, value };
  }
  if (isLeaf) {
    const next: Record<string, unknown> = { ...value };
    delete next[segment];
    return {
      changed: true,
      value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
    };
  }

  const child = unsetPathForWriteAt(value[segment], pathSegments, depth + 1);
  if (!child.changed) {
    return { changed: false, value };
  }
  const next: Record<string, unknown> = { ...value };
  if (child.value === WRITE_PRUNED_OBJECT) {
    delete next[segment];
  } else {
    next[segment] = child.value;
  }
  return {
    changed: true,
    value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
  };
}

function unsetPathForWrite(
  root: OpenClawConfig,
  pathSegments: string[],
): { changed: boolean; next: OpenClawConfig } {
  if (pathSegments.length === 0) {
    return { changed: false, next: root };
  }
  const result = unsetPathForWriteAt(root, pathSegments, 0);
  if (!result.changed) {
    return { changed: false, next: root };
  }
  if (result.value === WRITE_PRUNED_OBJECT) {
    return { changed: true, next: {} };
  }
  if (isWritePlainObject(result.value)) {
    return { changed: true, next: coerceConfig(result.value) };
  }
  return { changed: false, next: root };
}

export function resolveConfigSnapshotHash(snapshot: {
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

function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasConfigMeta(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const meta = value.meta;
  return isPlainObject(meta);
}

function resolveGatewayMode(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const gateway = value.gateway;
  if (!isPlainObject(gateway) || typeof gateway.mode !== "string") {
    return null;
  }
  const trimmed = gateway.mode.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

function createMergePatch(base: unknown, target: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(target)) {
    return cloneUnknown(target);
  }

  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of keys) {
    const hasBase = key in base;
    const hasTarget = key in target;
    if (!hasTarget) {
      patch[key] = null;
      continue;
    }
    const targetValue = target[key];
    if (!hasBase) {
      patch[key] = cloneUnknown(targetValue);
      continue;
    }
    const baseValue = base[key];
    if (isPlainObject(baseValue) && isPlainObject(targetValue)) {
      const childPatch = createMergePatch(baseValue, targetValue);
      if (isPlainObject(childPatch) && Object.keys(childPatch).length === 0) {
        continue;
      }
      patch[key] = childPatch;
      continue;
    }
    if (!isDeepStrictEqual(baseValue, targetValue)) {
      patch[key] = cloneUnknown(targetValue);
    }
  }
  return patch;
}

function collectEnvRefPaths(value: unknown, path: string, output: Map<string, string>): void {
  if (typeof value === "string") {
    if (containsEnvVarReference(value)) {
      output.set(path, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectEnvRefPaths(item, `${path}[${index}]`, output);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      collectEnvRefPaths(child, childPath, output);
    }
  }
}

function collectChangedPaths(
  base: unknown,
  target: unknown,
  path: string,
  output: Set<string>,
): void {
  if (Array.isArray(base) && Array.isArray(target)) {
    const max = Math.max(base.length, target.length);
    for (let index = 0; index < max; index += 1) {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      if (index >= base.length || index >= target.length) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[index], target[index], childPath, output);
    }
    return;
  }
  if (isPlainObject(base) && isPlainObject(target)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasBase = key in base;
      const hasTarget = key in target;
      if (!hasTarget || !hasBase) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[key], target[key], childPath, output);
    }
    return;
  }
  if (!isDeepStrictEqual(base, target)) {
    output.add(path);
  }
}

function parentPath(value: string): string {
  if (!value) {
    return "";
  }
  if (value.endsWith("]")) {
    const index = value.lastIndexOf("[");
    return index > 0 ? value.slice(0, index) : "";
  }
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(0, index) : "";
}

function isPathChanged(path: string, changedPaths: Set<string>): boolean {
  if (changedPaths.has(path)) {
    return true;
  }
  let current = parentPath(path);
  while (current) {
    if (changedPaths.has(current)) {
      return true;
    }
    current = parentPath(current);
  }
  return changedPaths.has("");
}

function restoreEnvRefsFromMap(
  value: unknown,
  path: string,
  envRefMap: Map<string, string>,
  changedPaths: Set<string>,
): unknown {
  if (typeof value === "string") {
    if (!isPathChanged(path, changedPaths)) {
      const original = envRefMap.get(path);
      if (original !== undefined) {
        return original;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const updated = restoreEnvRefsFromMap(item, `${path}[${index}]`, envRefMap, changedPaths);
      if (updated !== item) {
        changed = true;
      }
      return updated;
    });
    return changed ? next : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const updated = restoreEnvRefsFromMap(child, childPath, envRefMap, changedPaths);
      if (updated !== child) {
        changed = true;
      }
      next[key] = updated;
    }
    return changed ? next : value;
  }
  return value;
}

function resolveConfigAuditLogPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveStateDir(env, homedir), "logs", CONFIG_AUDIT_LOG_FILENAME);
}

function resolveConfigHealthStatePath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveStateDir(env, homedir), "logs", CONFIG_HEALTH_STATE_FILENAME);
}

function normalizeStatNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStatId(value: number | bigint | null | undefined): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function resolveConfigStatMetadata(
  stat: fs.Stats | null,
): Pick<ConfigHealthFingerprint, "dev" | "ino" | "mode" | "nlink" | "uid" | "gid"> {
  return {
    dev: normalizeStatId(stat?.dev ?? null),
    ino: normalizeStatId(stat?.ino ?? null),
    mode: normalizeStatNumber(stat ? stat.mode & 0o777 : null),
    nlink: normalizeStatNumber(stat?.nlink ?? null),
    uid: normalizeStatNumber(stat?.uid ?? null),
    gid: normalizeStatNumber(stat?.gid ?? null),
  };
}

function resolveConfigWriteSuspiciousReasons(params: {
  existsBefore: boolean;
  previousBytes: number | null;
  nextBytes: number | null;
  hasMetaBefore: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
}): string[] {
  const reasons: string[] = [];
  if (!params.existsBefore) {
    return reasons;
  }
  if (
    typeof params.previousBytes === "number" &&
    typeof params.nextBytes === "number" &&
    params.previousBytes >= 512 &&
    params.nextBytes < Math.floor(params.previousBytes * 0.5)
  ) {
    reasons.push(`size-drop:${params.previousBytes}->${params.nextBytes}`);
  }
  if (!params.hasMetaBefore) {
    reasons.push("missing-meta-before-write");
  }
  if (params.gatewayModeBefore && !params.gatewayModeAfter) {
    reasons.push("gateway-mode-removed");
  }
  return reasons;
}

async function appendConfigAuditRecord(
  deps: Required<ConfigIoDeps>,
  record: ConfigAuditRecord,
): Promise<void> {
  try {
    const auditPath = resolveConfigAuditLogPath(deps.env, deps.homedir);
    await deps.fs.promises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    await deps.fs.promises.appendFile(auditPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

function appendConfigAuditRecordSync(
  deps: Required<ConfigIoDeps>,
  record: ConfigAuditRecord,
): void {
  try {
    const auditPath = resolveConfigAuditLogPath(deps.env, deps.homedir);
    deps.fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    deps.fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

async function readConfigHealthState(deps: Required<ConfigIoDeps>): Promise<ConfigHealthState> {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    const raw = await deps.fs.promises.readFile(healthPath, "utf-8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

function readConfigHealthStateSync(deps: Required<ConfigIoDeps>): ConfigHealthState {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    const raw = deps.fs.readFileSync(healthPath, "utf-8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? (parsed as ConfigHealthState) : {};
  } catch {
    return {};
  }
}

async function writeConfigHealthState(
  deps: Required<ConfigIoDeps>,
  state: ConfigHealthState,
): Promise<void> {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    await deps.fs.promises.mkdir(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    await deps.fs.promises.writeFile(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

function writeConfigHealthStateSync(deps: Required<ConfigIoDeps>, state: ConfigHealthState): void {
  try {
    const healthPath = resolveConfigHealthStatePath(deps.env, deps.homedir);
    deps.fs.mkdirSync(path.dirname(healthPath), { recursive: true, mode: 0o700 });
    deps.fs.writeFileSync(healthPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best-effort
  }
}

function getConfigHealthEntry(state: ConfigHealthState, configPath: string): ConfigHealthEntry {
  const entries = state.entries;
  if (!entries || !isPlainObject(entries)) {
    return {};
  }
  const entry = entries[configPath];
  return entry && isPlainObject(entry) ? entry : {};
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
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "update") {
    return false;
  }
  const update = value.update;
  if (!isPlainObject(update)) {
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
  deps: Required<ConfigIoDeps>,
  targetPath: string,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(targetPath, "utf-8");
    const stat = await deps.fs.promises.stat(targetPath).catch(() => null);
    const parsedRes = parseConfigJson5(raw, deps.json5);
    const parsed = parsedRes.ok ? parsedRes.parsed : {};
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

function readConfigFingerprintForPathSync(
  deps: Required<ConfigIoDeps>,
  targetPath: string,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(targetPath, "utf-8");
    const stat = deps.fs.statSync(targetPath, { throwIfNoEntry: false }) ?? null;
    const parsedRes = parseConfigJson5(raw, deps.json5);
    const parsed = parsedRes.ok ? parsedRes.parsed : {};
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
  deps: Required<ConfigIoDeps>;
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
  deps: Required<ConfigIoDeps>;
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

type SuspiciousConfigRecoverySyncResult = {
  raw: string;
  parsed: unknown;
};

async function maybeRecoverSuspiciousConfigRead(params: {
  deps: Required<ConfigIoDeps>;
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
    ...resolveConfigStatMetadata(stat),
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
  const backupRaw = await params.deps.fs.promises.readFile(backupPath, "utf-8").catch(() => null);
  if (!backupRaw) {
    return { raw: params.raw, parsed: params.parsed };
  }
  const backupParsedRes = parseConfigJson5(backupRaw, params.deps.json5);
  if (!backupParsedRes.ok) {
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
  } catch {
    // Keep serving the backup payload for this read even if write-back fails.
  }

  params.deps.logger.warn(
    `Config auto-restored from backup: ${params.configPath} (${suspicious.join(", ")})`,
  );
  await appendConfigAuditRecord(params.deps, {
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
  return { raw: backupRaw, parsed: backupParsedRes.parsed };
}

function maybeRecoverSuspiciousConfigReadSync(params: {
  deps: Required<ConfigIoDeps>;
  configPath: string;
  raw: string;
  parsed: unknown;
}): SuspiciousConfigRecoverySyncResult {
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
  let backupRaw: string;
  try {
    backupRaw = params.deps.fs.readFileSync(backupPath, "utf-8");
  } catch {
    return { raw: params.raw, parsed: params.parsed };
  }
  const backupParsedRes = parseConfigJson5(backupRaw, params.deps.json5);
  if (!backupParsedRes.ok) {
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
  } catch {
    // Keep serving the backup payload for this read even if write-back fails.
  }

  params.deps.logger.warn(
    `Config auto-restored from backup: ${params.configPath} (${suspicious.join(", ")})`,
  );
  appendConfigAuditRecordSync(params.deps, {
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
  return { raw: backupRaw, parsed: backupParsedRes.parsed };
}

function sameFingerprint(
  left: ConfigHealthFingerprint | undefined,
  right: ConfigHealthFingerprint,
): boolean {
  if (!left) {
    return false;
  }
  return (
    left.hash === right.hash &&
    left.bytes === right.bytes &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.hasMeta === right.hasMeta &&
    left.gatewayMode === right.gatewayMode
  );
}

async function observeConfigSnapshot(
  deps: Required<ConfigIoDeps>,
  snapshot: ConfigFileSnapshot,
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
    ...resolveConfigStatMetadata(stat),
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
      if (
        !sameFingerprint(entry.lastKnownGood, current) ||
        entry.lastObservedSuspiciousSignature !== null
      ) {
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
  await appendConfigAuditRecord(deps, {
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

function observeConfigSnapshotSync(
  deps: Required<ConfigIoDeps>,
  snapshot: ConfigFileSnapshot,
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
      const nextEntry: ConfigHealthEntry = {
        lastKnownGood: current,
        lastObservedSuspiciousSignature: null,
      };
      if (
        !sameFingerprint(entry.lastKnownGood, current) ||
        entry.lastObservedSuspiciousSignature !== null
      ) {
        healthState = setConfigHealthEntry(healthState, snapshot.path, nextEntry);
        writeConfigHealthStateSync(deps, healthState);
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
    readConfigFingerprintForPathSync(deps, `${snapshot.path}.bak`);
  const clobberedPath = persistClobberedConfigSnapshotSync({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });

  deps.logger.warn(`Config observe anomaly: ${snapshot.path} (${suspicious.join(", ")})`);
  appendConfigAuditRecordSync(deps, {
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

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
};

function warnOnConfigMiskeys(raw: unknown, logger: Pick<typeof console, "warn">): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return;
  }
  if ("token" in (gateway as Record<string, unknown>)) {
    logger.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

function stampConfigVersion(cfg: OpenClawConfig): OpenClawConfig {
  const now = new Date().toISOString();
  return {
    ...cfg,
    meta: {
      ...cfg.meta,
      lastTouchedVersion: VERSION,
      lastTouchedAt: now,
    },
  };
}

function warnIfConfigFromFuture(cfg: OpenClawConfig, logger: Pick<typeof console, "warn">): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched) {
    return;
  }
  if (shouldWarnOnTouchedVersion(VERSION, touched)) {
    logger.warn(
      `Config was last written by a newer OpenClaw (${touched}); current version is ${VERSION}.`,
    );
  }
}

function resolveConfigPathForDeps(deps: Required<ConfigIoDeps>): string {
  if (deps.configPath) {
    return deps.configPath;
  }
  return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}

function normalizeDeps(overrides: ConfigIoDeps = {}): Required<ConfigIoDeps> {
  return {
    fs: overrides.fs ?? fs,
    json5: overrides.json5 ?? JSON5,
    env: overrides.env ?? process.env,
    homedir:
      overrides.homedir ?? (() => resolveRequiredHomeDir(overrides.env ?? process.env, os.homedir)),
    configPath: overrides.configPath ?? "",
    logger: overrides.logger ?? console,
  };
}

function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  // Only hydrate dotenv for the real process env. Callers using injected env
  // objects (tests/diagnostics) should stay isolated.
  if (env !== process.env) {
    return;
  }
  loadDotEnv({ quiet: true });
}

export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: json5.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

type ConfigReadResolution = {
  resolvedConfigRaw: unknown;
  envSnapshotForRestore: Record<string, string | undefined>;
  envWarnings: EnvSubstitutionWarning[];
};

type LegacyMigrationResolution = {
  effectiveConfigRaw: unknown;
  sourceLegacyIssues: LegacyConfigIssue[];
};

function resolveConfigIncludesForRead(
  parsed: unknown,
  configPath: string,
  deps: Required<ConfigIoDeps>,
): unknown {
  return resolveConfigIncludes(parsed, configPath, {
    readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
    readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
      readConfigIncludeFileWithGuards({
        includePath,
        resolvedPath,
        rootRealDir,
        ioFs: deps.fs,
      }),
    parseJson: (raw) => deps.json5.parse(raw),
  });
}

function resolveConfigForRead(
  resolvedIncludes: unknown,
  env: NodeJS.ProcessEnv,
): ConfigReadResolution {
  // Apply config.env to process.env BEFORE substitution so ${VAR} can reference config-defined vars.
  if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) {
    applyConfigEnvVars(resolvedIncludes as OpenClawConfig, env);
  }

  // Collect missing env var references as warnings instead of throwing,
  // so non-critical config sections with unset vars don't crash the gateway.
  const envWarnings: EnvSubstitutionWarning[] = [];
  return {
    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env, {
      onMissing: (w) => envWarnings.push(w),
    }),
    // Capture env snapshot after substitution for write-time ${VAR} restoration.
    envSnapshotForRestore: { ...env } as Record<string, string | undefined>,
    envWarnings,
  };
}

function resolveLegacyConfigForRead(
  resolvedConfigRaw: unknown,
  sourceRaw: unknown,
): LegacyMigrationResolution {
  const sourceLegacyIssues = findLegacyConfigIssues(resolvedConfigRaw, sourceRaw);
  if (sourceLegacyIssues.length === 0) {
    return { effectiveConfigRaw: resolvedConfigRaw, sourceLegacyIssues };
  }
  const migrated = migrateLegacyConfig(resolvedConfigRaw);
  return {
    effectiveConfigRaw: migrated.config ?? resolvedConfigRaw,
    sourceLegacyIssues,
  };
}

type ReadConfigFileSnapshotInternalResult = {
  snapshot: ConfigFileSnapshot;
  envSnapshotForRestore?: Record<string, string | undefined>;
};

function createConfigFileSnapshot(params: {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  sourceConfig: OpenClawConfig;
  valid: boolean;
  runtimeConfig: OpenClawConfig;
  hash?: string;
  issues: ConfigFileSnapshot["issues"];
  warnings: ConfigFileSnapshot["warnings"];
  legacyIssues: LegacyConfigIssue[];
}): ConfigFileSnapshot {
  const sourceConfig = asResolvedSourceConfig(params.sourceConfig);
  const runtimeConfig = asRuntimeConfig(params.runtimeConfig);
  return {
    path: params.path,
    exists: params.exists,
    raw: params.raw,
    parsed: params.parsed,
    sourceConfig,
    resolved: sourceConfig,
    valid: params.valid,
    runtimeConfig,
    config: runtimeConfig,
    hash: params.hash,
    issues: params.issues,
    warnings: params.warnings,
    legacyIssues: params.legacyIssues,
  };
}

async function finalizeReadConfigSnapshotInternalResult(
  deps: Required<ConfigIoDeps>,
  result: ReadConfigFileSnapshotInternalResult,
): Promise<ReadConfigFileSnapshotInternalResult> {
  await observeConfigSnapshot(deps, result.snapshot);
  return result;
}

export function createConfigIO(overrides: ConfigIoDeps = {}) {
  const deps = normalizeDeps(overrides);
  const requestedConfigPath = resolveConfigPathForDeps(deps);
  const candidatePaths = deps.configPath
    ? [requestedConfigPath]
    : resolveDefaultConfigCandidates(deps.env, deps.homedir);
  const configPath =
    candidatePaths.find((candidate) => deps.fs.existsSync(candidate)) ?? requestedConfigPath;

  function observeLoadConfigSnapshot(snapshot: ConfigFileSnapshot): ConfigFileSnapshot {
    observeConfigSnapshotSync(deps, snapshot);
    return snapshot;
  }

  function loadConfig(): OpenClawConfig {
    try {
      maybeLoadDotEnvForConfig(deps.env);
      if (!deps.fs.existsSync(configPath)) {
        if (shouldEnableShellEnvFallback(deps.env) && !shouldDeferShellEnvFallback(deps.env)) {
          loadShellEnvFallback({
            enabled: true,
            env: deps.env,
            expectedKeys: SHELL_ENV_EXPECTED_KEYS,
            logger: deps.logger,
            timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env),
          });
        }
        return {};
      }
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsed = deps.json5.parse(raw);
      const recovered = maybeRecoverSuspiciousConfigReadSync({
        deps,
        configPath,
        raw,
        parsed,
      });
      const effectiveRaw = recovered.raw;
      const effectiveParsed = recovered.parsed;
      const hash = hashConfigRaw(effectiveRaw);
      const readResolution = resolveConfigForRead(
        resolveConfigIncludesForRead(effectiveParsed, configPath, deps),
        deps.env,
      );
      const resolvedConfig = readResolution.resolvedConfigRaw;
      const legacyResolution = resolveLegacyConfigForRead(resolvedConfig, effectiveParsed);
      const effectiveConfigRaw = legacyResolution.effectiveConfigRaw;
      for (const w of readResolution.envWarnings) {
        deps.logger.warn(
          `Config (${configPath}): missing env var "${w.varName}" at ${w.configPath} — feature using this value will be unavailable`,
        );
      }
      warnOnConfigMiskeys(effectiveConfigRaw, deps.logger);
      if (typeof effectiveConfigRaw !== "object" || effectiveConfigRaw === null) {
        observeLoadConfigSnapshot({
          ...createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: effectiveRaw,
            parsed: effectiveParsed,
            sourceConfig: {},
            valid: true,
            runtimeConfig: {},
            hash,
            issues: [],
            warnings: [],
            legacyIssues: legacyResolution.sourceLegacyIssues,
          }),
        });
        return {};
      }
      const preValidationDuplicates = findDuplicateAgentDirs(effectiveConfigRaw as OpenClawConfig, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (preValidationDuplicates.length > 0) {
        throw new DuplicateAgentDirError(preValidationDuplicates);
      }
      const validated = validateConfigObjectWithPlugins(effectiveConfigRaw, { env: deps.env });
      if (!validated.ok) {
        observeLoadConfigSnapshot({
          ...createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: effectiveRaw,
            parsed: effectiveParsed,
            sourceConfig: coerceConfig(effectiveConfigRaw),
            valid: false,
            runtimeConfig: coerceConfig(effectiveConfigRaw),
            hash,
            issues: validated.issues,
            warnings: validated.warnings,
            legacyIssues: legacyResolution.sourceLegacyIssues,
          }),
        });
        const details = validated.issues
          .map(
            (iss) =>
              `- ${sanitizeTerminalText(iss.path || "<root>")}: ${sanitizeTerminalText(iss.message)}`,
          )
          .join("\n");
        if (!loggedInvalidConfigs.has(configPath)) {
          loggedInvalidConfigs.add(configPath);
          deps.logger.error(`Invalid config at ${configPath}:\\n${details}`);
        }
        const error = new Error(`Invalid config at ${configPath}:\n${details}`);
        (error as { code?: string; details?: string }).code = "INVALID_CONFIG";
        (error as { code?: string; details?: string }).details = details;
        throw error;
      }
      if (validated.warnings.length > 0) {
        const details = validated.warnings
          .map(
            (iss) =>
              `- ${sanitizeTerminalText(iss.path || "<root>")}: ${sanitizeTerminalText(iss.message)}`,
          )
          .join("\n");
        deps.logger.warn(`Config warnings:\\n${details}`);
      }
      warnIfConfigFromFuture(validated.config, deps.logger);
      const cfg = materializeRuntimeConfig(validated.config, "load");
      observeLoadConfigSnapshot({
        ...createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: effectiveRaw,
          parsed: effectiveParsed,
          sourceConfig: coerceConfig(effectiveConfigRaw),
          valid: true,
          runtimeConfig: cfg,
          hash,
          issues: [],
          warnings: validated.warnings,
          legacyIssues: legacyResolution.sourceLegacyIssues,
        }),
      });

      const duplicates = findDuplicateAgentDirs(cfg, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (duplicates.length > 0) {
        throw new DuplicateAgentDirError(duplicates);
      }

      applyConfigEnvVars(cfg, deps.env);

      const enabled = shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true;
      if (enabled && !shouldDeferShellEnvFallback(deps.env)) {
        loadShellEnvFallback({
          enabled: true,
          env: deps.env,
          expectedKeys: SHELL_ENV_EXPECTED_KEYS,
          logger: deps.logger,
          timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
        });
      }

      const pendingSecret = AUTO_OWNER_DISPLAY_SECRET_BY_PATH.get(configPath);
      const ownerDisplaySecretResolution = ensureOwnerDisplaySecret(
        cfg,
        () => pendingSecret ?? crypto.randomBytes(32).toString("hex"),
      );
      const cfgWithOwnerDisplaySecret = ownerDisplaySecretResolution.config;
      if (ownerDisplaySecretResolution.generatedSecret) {
        AUTO_OWNER_DISPLAY_SECRET_BY_PATH.set(
          configPath,
          ownerDisplaySecretResolution.generatedSecret,
        );
        if (!AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.has(configPath)) {
          AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.add(configPath);
          void writeConfigFile(cfgWithOwnerDisplaySecret, { expectedConfigPath: configPath })
            .then(() => {
              AUTO_OWNER_DISPLAY_SECRET_BY_PATH.delete(configPath);
              AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.delete(configPath);
            })
            .catch((err) => {
              if (!AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.has(configPath)) {
                AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.add(configPath);
                deps.logger.warn(
                  `Failed to persist auto-generated commands.ownerDisplaySecret at ${configPath}: ${String(err)}`,
                );
              }
            })
            .finally(() => {
              AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.delete(configPath);
            });
        }
      } else {
        AUTO_OWNER_DISPLAY_SECRET_BY_PATH.delete(configPath);
        AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.delete(configPath);
      }

      return applyConfigOverrides(cfgWithOwnerDisplaySecret);
    } catch (err) {
      if (err instanceof DuplicateAgentDirError) {
        deps.logger.error(err.message);
        throw err;
      }
      const error = err as { code?: string };
      if (error?.code === "INVALID_CONFIG") {
        // Fail closed so invalid configs cannot silently fall back to permissive defaults.
        throw err;
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      throw err;
    }
  }

  async function readConfigFileSnapshotInternal(): Promise<ReadConfigFileSnapshotInternalResult> {
    maybeLoadDotEnvForConfig(deps.env);
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      const hash = hashConfigRaw(null);
      const config = materializeRuntimeConfig({}, "missing");
      const legacyIssues: LegacyConfigIssue[] = [];
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          exists: false,
          raw: null,
          parsed: {},
          sourceConfig: {},
          valid: true,
          runtimeConfig: config,
          hash,
          issues: [],
          warnings: [],
          legacyIssues,
        }),
      });
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const rawHash = hashConfigRaw(raw);
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw,
            parsed: {},
            sourceConfig: {},
            valid: false,
            runtimeConfig: {},
            hash: rawHash,
            issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
            warnings: [],
            legacyIssues: [],
          }),
        });
      }

      // Resolve $include directives
      const recovered = await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw,
        parsed: parsedRes.parsed,
      });
      const effectiveRaw = recovered.raw;
      const effectiveParsed = recovered.parsed;
      const hash = hashConfigRaw(effectiveRaw);

      let resolved: unknown;
      try {
        resolved = resolveConfigIncludesForRead(effectiveParsed, configPath, deps);
      } catch (err) {
        const message =
          err instanceof ConfigIncludeError
            ? err.message
            : `Include resolution failed: ${String(err)}`;
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: effectiveRaw,
            parsed: effectiveParsed,
            // Keep the recovered root file payload here when read healing kicked in.
            sourceConfig: coerceConfig(effectiveParsed),
            valid: false,
            runtimeConfig: coerceConfig(effectiveParsed),
            hash,
            issues: [{ path: "", message }],
            warnings: [],
            legacyIssues: [],
          }),
        });
      }

      const readResolution = resolveConfigForRead(resolved, deps.env);

      // Convert missing env var references to config warnings instead of fatal errors.
      // This allows the gateway to start in degraded mode when non-critical config
      // sections reference unset env vars (e.g. optional provider API keys).
      const envVarWarnings = readResolution.envWarnings.map((w) => ({
        path: w.configPath,
        message: `Missing env var "${w.varName}" — feature using this value will be unavailable`,
      }));

      const resolvedConfigRaw = readResolution.resolvedConfigRaw;
      const legacyResolution = resolveLegacyConfigForRead(resolvedConfigRaw, effectiveParsed);
      const effectiveConfigRaw = legacyResolution.effectiveConfigRaw;

      const validated = validateConfigObjectWithPlugins(effectiveConfigRaw, { env: deps.env });
      if (!validated.ok) {
        return await finalizeReadConfigSnapshotInternalResult(deps, {
          snapshot: createConfigFileSnapshot({
            path: configPath,
            exists: true,
            raw: effectiveRaw,
            parsed: effectiveParsed,
            sourceConfig: coerceConfig(effectiveConfigRaw),
            valid: false,
            runtimeConfig: coerceConfig(effectiveConfigRaw),
            hash,
            issues: validated.issues,
            warnings: [...validated.warnings, ...envVarWarnings],
            legacyIssues: legacyResolution.sourceLegacyIssues,
          }),
        });
      }

      warnIfConfigFromFuture(validated.config, deps.logger);
      const snapshotConfig = materializeRuntimeConfig(validated.config, "snapshot");
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: effectiveRaw,
          parsed: effectiveParsed,
          // Use resolvedConfigRaw (after $include and ${ENV} substitution but BEFORE runtime defaults)
          // for config set/unset operations (issue #6070)
          sourceConfig: coerceConfig(effectiveConfigRaw),
          valid: true,
          runtimeConfig: snapshotConfig,
          hash,
          issues: [],
          warnings: [...validated.warnings, ...envVarWarnings],
          legacyIssues: legacyResolution.sourceLegacyIssues,
        }),
        envSnapshotForRestore: readResolution.envSnapshotForRestore,
      });
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      let message: string;
      if (nodeErr?.code === "EACCES") {
        // Permission denied — common in Docker/container deployments where the
        // config file is owned by root but the gateway runs as a non-root user.
        const uid = process.getuid?.();
        const uidHint = typeof uid === "number" ? String(uid) : "$(id -u)";
        message = [
          `read failed: ${String(err)}`,
          ``,
          `Config file is not readable by the current process. If running in a container`,
          `or 1-click deployment, fix ownership with:`,
          `  chown ${uidHint} "${configPath}"`,
          `Then restart the gateway.`,
        ].join("\n");
        deps.logger.error(message);
      } else {
        message = `read failed: ${String(err)}`;
      }
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          exists: true,
          raw: null,
          parsed: {},
          sourceConfig: {},
          valid: false,
          runtimeConfig: {},
          hash: hashConfigRaw(null),
          issues: [{ path: "", message }],
          warnings: [],
          legacyIssues: [],
        }),
      });
    }
  }

  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    const result = await readConfigFileSnapshotInternal();
    return result.snapshot;
  }

  async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
    const result = await readConfigFileSnapshotInternal();
    return {
      snapshot: result.snapshot,
      writeOptions: {
        envSnapshotForRestore: result.envSnapshotForRestore,
        expectedConfigPath: configPath,
      },
    };
  }

  async function writeConfigFile(
    cfg: OpenClawConfig,
    options: ConfigWriteOptions = {},
  ): Promise<{ persistedHash: string }> {
    clearConfigCache();
    let persistCandidate: unknown = cfg;
    const { snapshot } = await readConfigFileSnapshotInternal();
    let envRefMap: Map<string, string> | null = null;
    let changedPaths: Set<string> | null = null;
    if (snapshot.valid && snapshot.exists) {
      const patch = createMergePatch(snapshot.config, cfg);
      persistCandidate = applyMergePatch(snapshot.resolved, patch);
      try {
        const resolvedIncludes = resolveConfigIncludes(snapshot.parsed, configPath, {
          readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
          readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
            readConfigIncludeFileWithGuards({
              includePath,
              resolvedPath,
              rootRealDir,
              ioFs: deps.fs,
            }),
          parseJson: (raw) => deps.json5.parse(raw),
        });
        const collected = new Map<string, string>();
        collectEnvRefPaths(resolvedIncludes, "", collected);
        if (collected.size > 0) {
          envRefMap = collected;
          changedPaths = new Set<string>();
          collectChangedPaths(snapshot.config, cfg, "", changedPaths);
        }
      } catch {
        envRefMap = null;
      }
    }

    const validated = validateConfigObjectRawWithPlugins(persistCandidate, { env: deps.env });
    if (!validated.ok) {
      const issue = validated.issues[0];
      const pathLabel = issue?.path ? issue.path : "<root>";
      const issueMessage = issue?.message ?? "invalid";
      throw new Error(formatConfigValidationFailure(pathLabel, issueMessage));
    }
    if (validated.warnings.length > 0) {
      const details = validated.warnings
        .map((warning) => `- ${warning.path}: ${warning.message}`)
        .join("\n");
      deps.logger.warn(`Config warnings:\n${details}`);
    }

    // Restore ${VAR} env var references that were resolved during config loading.
    // Read the current file (pre-substitution) and restore any references whose
    // resolved values match the incoming config — so we don't overwrite
    // "${ANTHROPIC_API_KEY}" with "sk-ant-..." when the caller didn't change it.
    //
    // We use only the root file's parsed content (no $include resolution) to avoid
    // pulling values from included files into the root config on write-back.
    // Use persistCandidate (the merge-patched value before validation) rather than
    // validated.config, because plugin/channel AJV validation may inject schema
    // defaults (e.g., enrichGroupParticipantsFromContacts) that should not be
    // persisted to disk (issue #56772).
    let cfgToWrite = persistCandidate as OpenClawConfig;
    try {
      if (deps.fs.existsSync(configPath)) {
        const currentRaw = await deps.fs.promises.readFile(configPath, "utf-8");
        const parsedRes = parseConfigJson5(currentRaw, deps.json5);
        if (parsedRes.ok) {
          // Use env snapshot from when config was loaded (if available) to avoid
          // TOCTOU issues where env changes between load and write. Falls back to
          // live env if no snapshot exists (e.g., first write before any load).
          const envForRestore = options.envSnapshotForRestore ?? deps.env;
          cfgToWrite = restoreEnvVarRefs(
            cfgToWrite,
            parsedRes.parsed,
            envForRestore,
          ) as OpenClawConfig;
        }
      }
    } catch {
      // If reading the current file fails, write cfg as-is (no env restoration)
    }

    const dir = path.dirname(configPath);
    await deps.fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await tightenStateDirPermissionsIfNeeded({
      configPath,
      env: deps.env,
      homedir: deps.homedir,
      fsModule: deps.fs,
    });
    const outputConfigBase =
      envRefMap && changedPaths
        ? (restoreEnvRefsFromMap(cfgToWrite, "", envRefMap, changedPaths) as OpenClawConfig)
        : cfgToWrite;
    let outputConfig = outputConfigBase;
    if (options.unsetPaths?.length) {
      for (const unsetPath of options.unsetPaths) {
        if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
          continue;
        }
        const unsetResult = unsetPathForWrite(outputConfig, unsetPath);
        if (unsetResult.changed) {
          outputConfig = unsetResult.next;
        }
      }
    }
    // Do NOT apply runtime defaults when writing — user config should only contain
    // explicitly set values. Runtime defaults are applied when loading (issue #6070).
    const stampedOutputConfig = stampConfigVersion(outputConfig);
    const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
    const nextHash = hashConfigRaw(json);
    const previousHash = resolveConfigSnapshotHash(snapshot);
    const changedPathCount = changedPaths?.size;
    const previousBytes =
      typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
    const nextBytes = Buffer.byteLength(json, "utf-8");
    const previousStat = snapshot.exists
      ? await deps.fs.promises.stat(configPath).catch(() => null)
      : null;
    const hasMetaBefore = hasConfigMeta(snapshot.parsed);
    const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
    const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
    const gatewayModeAfter = resolveGatewayMode(stampedOutputConfig);
    const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
      existsBefore: snapshot.exists,
      previousBytes,
      nextBytes,
      hasMetaBefore,
      gatewayModeBefore,
      gatewayModeAfter,
    });
    const logConfigOverwrite = () => {
      if (!snapshot.exists) {
        return;
      }
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_OVERWRITE_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      const changeSummary =
        typeof changedPathCount === "number" ? `, changedPaths=${changedPathCount}` : "";
      deps.logger.warn(
        `Config overwrite: ${configPath} (sha256 ${previousHash ?? "unknown"} -> ${nextHash}, backup=${configPath}.bak${changeSummary})`,
      );
    };
    const logConfigWriteAnomalies = () => {
      if (suspiciousReasons.length === 0) {
        return;
      }
      // Tests often write minimal configs (missing meta, etc); keep output quiet unless requested.
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_WRITE_ANOMALY_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      deps.logger.warn(`Config write anomaly: ${configPath} (${suspiciousReasons.join(", ")})`);
    };
    const auditRecordBase = {
      ts: new Date().toISOString(),
      source: "config-io" as const,
      event: "config.write" as const,
      configPath,
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      argv: process.argv.slice(0, 8),
      execArgv: process.execArgv.slice(0, 8),
      watchMode: deps.env.OPENCLAW_WATCH_MODE === "1",
      watchSession:
        typeof deps.env.OPENCLAW_WATCH_SESSION === "string" &&
        deps.env.OPENCLAW_WATCH_SESSION.trim().length > 0
          ? deps.env.OPENCLAW_WATCH_SESSION.trim()
          : null,
      watchCommand:
        typeof deps.env.OPENCLAW_WATCH_COMMAND === "string" &&
        deps.env.OPENCLAW_WATCH_COMMAND.trim().length > 0
          ? deps.env.OPENCLAW_WATCH_COMMAND.trim()
          : null,
      existsBefore: snapshot.exists,
      previousHash: previousHash ?? null,
      nextHash,
      previousBytes,
      nextBytes,
      previousDev: resolveConfigStatMetadata(previousStat).dev,
      nextDev: null,
      previousIno: resolveConfigStatMetadata(previousStat).ino,
      nextIno: null,
      previousMode: resolveConfigStatMetadata(previousStat).mode,
      nextMode: null,
      previousNlink: resolveConfigStatMetadata(previousStat).nlink,
      nextNlink: null,
      previousUid: resolveConfigStatMetadata(previousStat).uid,
      nextUid: null,
      previousGid: resolveConfigStatMetadata(previousStat).gid,
      nextGid: null,
      changedPathCount: typeof changedPathCount === "number" ? changedPathCount : null,
      hasMetaBefore,
      hasMetaAfter,
      gatewayModeBefore,
      gatewayModeAfter,
      suspicious: suspiciousReasons,
    };
    const appendWriteAudit = async (
      result: ConfigWriteAuditResult,
      err?: unknown,
      nextStat?: fs.Stats | null,
    ) => {
      const errorCode =
        err && typeof err === "object" && "code" in err && typeof err.code === "string"
          ? err.code
          : undefined;
      const errorMessage =
        err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : undefined;
      const nextMetadata = resolveConfigStatMetadata(nextStat ?? null);
      await appendConfigAuditRecord(deps, {
        ...auditRecordBase,
        result,
        nextHash: result === "failed" ? null : auditRecordBase.nextHash,
        nextBytes: result === "failed" ? null : auditRecordBase.nextBytes,
        nextDev: result === "failed" ? null : nextMetadata.dev,
        nextIno: result === "failed" ? null : nextMetadata.ino,
        nextMode: result === "failed" ? null : nextMetadata.mode,
        nextNlink: result === "failed" ? null : nextMetadata.nlink,
        nextUid: result === "failed" ? null : nextMetadata.uid,
        nextGid: result === "failed" ? null : nextMetadata.gid,
        errorCode,
        errorMessage,
      });
    };

    const tmp = path.join(
      dir,
      `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    try {
      await deps.fs.promises.writeFile(tmp, json, {
        encoding: "utf-8",
        mode: 0o600,
      });

      if (deps.fs.existsSync(configPath)) {
        await maintainConfigBackups(configPath, deps.fs.promises);
      }

      try {
        await deps.fs.promises.rename(tmp, configPath);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Windows doesn't reliably support atomic replace via rename when dest exists.
        if (code === "EPERM" || code === "EEXIST") {
          await deps.fs.promises.copyFile(tmp, configPath);
          await deps.fs.promises.chmod(configPath, 0o600).catch(() => {
            // best-effort
          });
          await deps.fs.promises.unlink(tmp).catch(() => {
            // best-effort
          });
          logConfigOverwrite();
          logConfigWriteAnomalies();
          await appendWriteAudit(
            "copy-fallback",
            undefined,
            await deps.fs.promises.stat(configPath).catch(() => null),
          );
          return { persistedHash: nextHash };
        }
        await deps.fs.promises.unlink(tmp).catch(() => {
          // best-effort
        });
        throw err;
      }
      logConfigOverwrite();
      logConfigWriteAnomalies();
      await appendWriteAudit(
        "rename",
        undefined,
        await deps.fs.promises.stat(configPath).catch(() => null),
      );
      return { persistedHash: nextHash };
    } catch (err) {
      await appendWriteAudit("failed", err);
      throw err;
    }
  }

  return {
    configPath,
    loadConfig,
    readConfigFileSnapshot,
    readConfigFileSnapshotForWrite,
    writeConfigFile,
  };
}

// NOTE: These wrappers intentionally do *not* cache the resolved config path at
// module scope. `OPENCLAW_CONFIG_PATH` (and friends) are expected to work even
// when set after the module has been imported (tests, one-off scripts, etc.).
const AUTO_OWNER_DISPLAY_SECRET_BY_PATH = new Map<string, string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT = new Set<string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED = new Set<string>();
let runtimeConfigSnapshot: OpenClawConfig | null = null;
let runtimeConfigSourceSnapshot: OpenClawConfig | null = null;
let runtimeConfigSnapshotRefreshHandler: RuntimeConfigSnapshotRefreshHandler | null = null;
const configWriteListeners = new Set<(event: ConfigWriteNotification) => void>();

function notifyConfigWriteListeners(event: ConfigWriteNotification): void {
  for (const listener of configWriteListeners) {
    try {
      listener(event);
    } catch {
      // Best-effort observer path only; successful writes must still complete.
    }
  }
}

export function clearConfigCache(): void {
  // Compat shim: runtime snapshot is the only in-process cache now.
}

export function registerConfigWriteListener(
  listener: (event: ConfigWriteNotification) => void,
): () => void {
  configWriteListeners.add(listener);
  return () => {
    configWriteListeners.delete(listener);
  };
}

export function setRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
): void {
  runtimeConfigSnapshot = config;
  runtimeConfigSourceSnapshot = sourceConfig ?? null;
}

export function resetConfigRuntimeState(): void {
  runtimeConfigSnapshot = null;
  runtimeConfigSourceSnapshot = null;
}

export function clearRuntimeConfigSnapshot(): void {
  resetConfigRuntimeState();
}

export function getRuntimeConfigSnapshot(): OpenClawConfig | null {
  return runtimeConfigSnapshot;
}

export function getRuntimeConfigSourceSnapshot(): OpenClawConfig | null {
  return runtimeConfigSourceSnapshot;
}

function isCompatibleTopLevelRuntimeProjectionShape(params: {
  runtimeSnapshot: OpenClawConfig;
  candidate: OpenClawConfig;
}): boolean {
  const runtime = params.runtimeSnapshot as Record<string, unknown>;
  const candidate = params.candidate as Record<string, unknown>;
  for (const key of Object.keys(runtime)) {
    if (!Object.hasOwn(candidate, key)) {
      return false;
    }
    const runtimeValue = runtime[key];
    const candidateValue = candidate[key];
    const runtimeType = Array.isArray(runtimeValue)
      ? "array"
      : runtimeValue === null
        ? "null"
        : typeof runtimeValue;
    const candidateType = Array.isArray(candidateValue)
      ? "array"
      : candidateValue === null
        ? "null"
        : typeof candidateValue;
    if (runtimeType !== candidateType) {
      return false;
    }
  }
  return true;
}

export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  if (!runtimeConfigSnapshot || !runtimeConfigSourceSnapshot) {
    return config;
  }
  if (config === runtimeConfigSnapshot) {
    return runtimeConfigSourceSnapshot;
  }
  // This projection expects callers to pass config objects derived from the
  // active runtime snapshot (for example shallow/deep clones with targeted edits).
  // For structurally unrelated configs, skip projection to avoid accidental
  // merge-patch deletions or reintroducing resolved values into source refs.
  if (
    !isCompatibleTopLevelRuntimeProjectionShape({
      runtimeSnapshot: runtimeConfigSnapshot,
      candidate: config,
    })
  ) {
    return config;
  }
  const runtimePatch = createMergePatch(runtimeConfigSnapshot, config);
  return coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot, runtimePatch));
}

export function setRuntimeConfigSnapshotRefreshHandler(
  refreshHandler: RuntimeConfigSnapshotRefreshHandler | null,
): void {
  runtimeConfigSnapshotRefreshHandler = refreshHandler;
}

export function loadConfig(): OpenClawConfig {
  if (runtimeConfigSnapshot) {
    return runtimeConfigSnapshot;
  }
  const config = createConfigIO().loadConfig();
  // First successful load becomes the process snapshot. Long-lived runtimes
  // should swap this snapshot via explicit reload/watcher paths instead of
  // reparsing openclaw.json on hot code paths.
  setRuntimeConfigSnapshot(config);
  return runtimeConfigSnapshot ?? config;
}

export function getRuntimeConfig(): OpenClawConfig {
  return loadConfig();
}

export async function readBestEffortConfig(): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  return snapshot.valid ? loadConfig() : snapshot.config;
}

export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  return await createConfigIO().readConfigFileSnapshot();
}

export async function readSourceConfigSnapshot(): Promise<ConfigFileSnapshot> {
  return await readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await createConfigIO().readConfigFileSnapshotForWrite();
}

export async function readSourceConfigSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await readConfigFileSnapshotForWrite();
}

export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  const io = createConfigIO();
  let nextCfg = cfg;
  const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
  const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
  if (hadBothSnapshots) {
    const runtimePatch = createMergePatch(runtimeConfigSnapshot!, cfg);
    nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot!, runtimePatch));
  }
  const sameConfigPath =
    options.expectedConfigPath === undefined || options.expectedConfigPath === io.configPath;
  const writeResult = await io.writeConfigFile(nextCfg, {
    envSnapshotForRestore: sameConfigPath ? options.envSnapshotForRestore : undefined,
    unsetPaths: options.unsetPaths,
  });
  const notifyCommittedWrite = () => {
    if (!runtimeConfigSnapshot) {
      return;
    }
    notifyConfigWriteListeners({
      configPath: io.configPath,
      sourceConfig: nextCfg,
      runtimeConfig: runtimeConfigSnapshot,
      persistedHash: writeResult.persistedHash,
      writtenAtMs: Date.now(),
    });
  };
  // Keep the last-known-good runtime snapshot active until the specialized refresh path
  // succeeds, so concurrent readers do not observe unresolved SecretRefs mid-refresh.
  const refreshHandler = runtimeConfigSnapshotRefreshHandler;
  if (refreshHandler) {
    try {
      const refreshed = await refreshHandler.refresh({ sourceConfig: nextCfg });
      if (refreshed) {
        notifyCommittedWrite();
        return;
      }
    } catch (error) {
      try {
        refreshHandler.clearOnRefreshFailure?.();
      } catch {
        // Keep the original refresh failure as the surfaced error.
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigRuntimeRefreshError(
        `Config was written to ${io.configPath}, but runtime snapshot refresh failed: ${detail}`,
        { cause: error },
      );
    }
  }
  if (hadBothSnapshots) {
    // Refresh both snapshots from disk atomically so follow-up reads get normalized config and
    // subsequent writes still get secret-preservation merge-patch (hadBothSnapshots stays true).
    const fresh = io.loadConfig();
    setRuntimeConfigSnapshot(fresh, nextCfg);
    notifyCommittedWrite();
    return;
  }
  if (hadRuntimeSnapshot) {
    const fresh = io.loadConfig();
    setRuntimeConfigSnapshot(fresh);
    notifyCommittedWrite();
    return;
  }
  setRuntimeConfigSnapshot(io.loadConfig());
  notifyCommittedWrite();
}

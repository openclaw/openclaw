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
import { VERSION } from "../version.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { rotateConfigBackups } from "./backup-rotation.js";
import {
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyAgentDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkApiKey,
} from "./defaults.js";
import { restoreEnvVarRefs } from "./env-preserve.js";
import {
  MissingEnvVarError,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "./env-substitution.js";
import { applyConfigEnvVars } from "./env-vars.js";
import { ConfigIncludeError, resolveConfigIncludes } from "./includes.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { applyMergePatch } from "./merge-patch.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import { normalizeConfigPaths } from "./normalize-paths.js";
import { resolveConfigPath, resolveDefaultConfigCandidates, resolveStateDir } from "./paths.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import type { OpenClawConfig, ConfigFileSnapshot, LegacyConfigIssue } from "./types.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
import { compareOpenClawVersions } from "./version.js";

// Re-export for backwards compatibility
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";

const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "MINIMAX_API_KEY",
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

const CONFIG_AUDIT_LOG_FILENAME = "config-audit.jsonl";
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
  changedPathCount: number | null;
  hasMetaBefore: boolean;
  hasMetaAfter: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
  suspicious: string[];
  errorCode?: string;
  errorMessage?: string;
};

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

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
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

async function appendConfigWriteAuditRecord(
  deps: Required<ConfigIoDeps>,
  record: ConfigWriteAuditRecord,
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
  const cmp = compareOpenClawVersions(VERSION, touched);
  if (cmp === null) {
    return;
  }
  if (cmp < 0) {
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
};

function resolveConfigIncludesForRead(
  parsed: unknown,
  configPath: string,
  deps: Required<ConfigIoDeps>,
): unknown {
  return resolveConfigIncludes(parsed, configPath, {
    readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
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

  return {
    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env),
    // Capture env snapshot after substitution for write-time ${VAR} restoration.
    envSnapshotForRestore: { ...env } as Record<string, string | undefined>,
  };
}

type ReadConfigFileSnapshotInternalResult = {
  snapshot: ConfigFileSnapshot;
  envSnapshotForRestore?: Record<string, string | undefined>;
};

export function createConfigIO(overrides: ConfigIoDeps = {}) {
  const deps = normalizeDeps(overrides);
  const requestedConfigPath = resolveConfigPathForDeps(deps);
  const candidatePaths = deps.configPath
    ? [requestedConfigPath]
    : resolveDefaultConfigCandidates(deps.env, deps.homedir);
  const configPath =
    candidatePaths.find((candidate) => deps.fs.existsSync(candidate)) ?? requestedConfigPath;

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
      const { resolvedConfigRaw: resolvedConfig } = resolveConfigForRead(
        resolveConfigIncludesForRead(parsed, configPath, deps),
        deps.env,
      );
      warnOnConfigMiskeys(resolvedConfig, deps.logger);
      if (typeof resolvedConfig !== "object" || resolvedConfig === null) {
        return {};
      }
      const preValidationDuplicates = findDuplicateAgentDirs(resolvedConfig as OpenClawConfig, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (preValidationDuplicates.length > 0) {
        throw new DuplicateAgentDirError(preValidationDuplicates);
      }
      const validated = validateConfigObjectWithPlugins(resolvedConfig);
      if (!validated.ok) {
        const details = validated.issues
          .map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`)
          .join("\n");
        if (!loggedInvalidConfigs.has(configPath)) {
          loggedInvalidConfigs.add(configPath);
          deps.logger.error(`Invalid config at ${configPath}:\\n${details}`);
        }
        const error = new Error("Invalid config");
        (error as { code?: string; details?: string }).code = "INVALID_CONFIG";
        (error as { code?: string; details?: string }).details = details;
        throw error;
      }
      if (validated.warnings.length > 0) {
        const details = validated.warnings
          .map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`)
          .join("\n");
        deps.logger.warn(`Config warnings:\\n${details}`);
      }
      warnIfConfigFromFuture(validated.config, deps.logger);
      const cfg = applyModelDefaults(
        applyCompactionDefaults(
          applyContextPruningDefaults(
            applyAgentDefaults(
              applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
            ),
          ),
        ),
      );
      normalizeConfigPaths(cfg);
      normalizeExecSafeBinProfilesInConfig(cfg);

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
        return {};
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      return {};
    }
  }

  async function readConfigFileSnapshotInternal(): Promise<ReadConfigFileSnapshotInternalResult> {
    maybeLoadDotEnvForConfig(deps.env);
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      const hash = hashConfigRaw(null);
      const config = applyTalkApiKey(
        applyModelDefaults(
          applyCompactionDefaults(
            applyContextPruningDefaults(
              applyAgentDefaults(applySessionDefaults(applyMessageDefaults({}))),
            ),
          ),
        ),
      );
      const legacyIssues: LegacyConfigIssue[] = [];
      return {
        snapshot: {
          path: configPath,
          exists: false,
          raw: null,
          parsed: {},
          resolved: {},
          valid: true,
          config,
          hash,
          issues: [],
          warnings: [],
          legacyIssues,
        },
      };
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const hash = hashConfigRaw(raw);
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: {},
            resolved: {},
            valid: false,
            config: {},
            hash,
            issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
            warnings: [],
            legacyIssues: [],
          },
        };
      }

      // Resolve $include directives
      let resolved: unknown;
      try {
        resolved = resolveConfigIncludesForRead(parsedRes.parsed, configPath, deps);
      } catch (err) {
        const message =
          err instanceof ConfigIncludeError
            ? err.message
            : `Include resolution failed: ${String(err)}`;
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: parsedRes.parsed,
            resolved: coerceConfig(parsedRes.parsed),
            valid: false,
            config: coerceConfig(parsedRes.parsed),
            hash,
            issues: [{ path: "", message }],
            warnings: [],
            legacyIssues: [],
          },
        };
      }

      let readResolution: ConfigReadResolution;
      try {
        readResolution = resolveConfigForRead(resolved, deps.env);
      } catch (err) {
        const message =
          err instanceof MissingEnvVarError
            ? err.message
            : `Env var substitution failed: ${String(err)}`;
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: parsedRes.parsed,
            resolved: coerceConfig(resolved),
            valid: false,
            config: coerceConfig(resolved),
            hash,
            issues: [{ path: "", message }],
            warnings: [],
            legacyIssues: [],
          },
        };
      }

      const resolvedConfigRaw = readResolution.resolvedConfigRaw;
      const legacyIssues = findLegacyConfigIssues(resolvedConfigRaw);

      const validated = validateConfigObjectWithPlugins(resolvedConfigRaw);
      if (!validated.ok) {
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: parsedRes.parsed,
            resolved: coerceConfig(resolvedConfigRaw),
            valid: false,
            config: coerceConfig(resolvedConfigRaw),
            hash,
            issues: validated.issues,
            warnings: validated.warnings,
            legacyIssues,
          },
        };
      }

      warnIfConfigFromFuture(validated.config, deps.logger);
      const snapshotConfig = normalizeConfigPaths(
        applyTalkApiKey(
          applyModelDefaults(
            applyAgentDefaults(
              applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
            ),
          ),
        ),
      );
      normalizeExecSafeBinProfilesInConfig(snapshotConfig);
      return {
        snapshot: {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          // Use resolvedConfigRaw (after $include and ${ENV} substitution but BEFORE runtime defaults)
          // for config set/unset operations (issue #6070)
          resolved: coerceConfig(resolvedConfigRaw),
          valid: true,
          config: snapshotConfig,
          hash,
          issues: [],
          warnings: validated.warnings,
          legacyIssues,
        },
        envSnapshotForRestore: readResolution.envSnapshotForRestore,
      };
    } catch (err) {
      return {
        snapshot: {
          path: configPath,
          exists: true,
          raw: null,
          parsed: {},
          resolved: {},
          valid: false,
          config: {},
          hash: hashConfigRaw(null),
          issues: [{ path: "", message: `read failed: ${String(err)}` }],
          warnings: [],
          legacyIssues: [],
        },
      };
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

  async function writeConfigFile(cfg: OpenClawConfig, options: ConfigWriteOptions = {}) {
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

    const validated = validateConfigObjectRawWithPlugins(persistCandidate);
    if (!validated.ok) {
      const issue = validated.issues[0];
      const pathLabel = issue?.path ? issue.path : "<root>";
      throw new Error(`Config validation failed: ${pathLabel}: ${issue?.message ?? "invalid"}`);
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
    // Apply env restoration to validated.config (which has runtime defaults stripped
    // per issue #6070) rather than the raw caller input.
    let cfgToWrite = validated.config;
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
      changedPathCount: typeof changedPathCount === "number" ? changedPathCount : null,
      hasMetaBefore,
      hasMetaAfter,
      gatewayModeBefore,
      gatewayModeAfter,
      suspicious: suspiciousReasons,
    };
    const appendWriteAudit = async (result: ConfigWriteAuditResult, err?: unknown) => {
      const errorCode =
        err && typeof err === "object" && "code" in err && typeof err.code === "string"
          ? err.code
          : undefined;
      const errorMessage =
        err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : undefined;
      await appendConfigWriteAuditRecord(deps, {
        ...auditRecordBase,
        result,
        nextHash: result === "failed" ? null : auditRecordBase.nextHash,
        nextBytes: result === "failed" ? null : auditRecordBase.nextBytes,
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
        await rotateConfigBackups(configPath, deps.fs.promises);
        await deps.fs.promises.copyFile(configPath, `${configPath}.bak`).catch(() => {
          // best-effort
        });
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
          await appendWriteAudit("copy-fallback");
          return;
        }
        await deps.fs.promises.unlink(tmp).catch(() => {
          // best-effort
        });
        throw err;
      }
      logConfigOverwrite();
      logConfigWriteAnomalies();
      await appendWriteAudit("rename");
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
const DEFAULT_CONFIG_CACHE_MS = 200;
const AUTO_OWNER_DISPLAY_SECRET_BY_PATH = new Map<string, string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT = new Set<string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED = new Set<string>();
let configCache: {
  configPath: string;
  expiresAt: number;
  config: OpenClawConfig;
} | null = null;

function resolveConfigCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_CONFIG_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_CONFIG_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CONFIG_CACHE_MS;
  }
  return Math.max(0, parsed);
}

function shouldUseConfigCache(env: NodeJS.ProcessEnv): boolean {
  if (env.OPENCLAW_DISABLE_CONFIG_CACHE?.trim()) {
    return false;
  }
  return resolveConfigCacheMs(env) > 0;
}

export function clearConfigCache(): void {
  configCache = null;
}

export function loadConfig(): OpenClawConfig {
  const io = createConfigIO();
  const configPath = io.configPath;
  const now = Date.now();
  if (shouldUseConfigCache(process.env)) {
    const cached = configCache;
    if (cached && cached.configPath === configPath && cached.expiresAt > now) {
      return cached.config;
    }
  }
  const config = io.loadConfig();
  if (shouldUseConfigCache(process.env)) {
    const cacheMs = resolveConfigCacheMs(process.env);
    if (cacheMs > 0) {
      configCache = {
        configPath,
        expiresAt: now + cacheMs,
        config,
      };
    }
  }
  return config;
}

export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  return await createConfigIO().readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await createConfigIO().readConfigFileSnapshotForWrite();
}

export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  const io = createConfigIO();
  const sameConfigPath =
    options.expectedConfigPath === undefined || options.expectedConfigPath === io.configPath;
  await io.writeConfigFile(cfg, {
    envSnapshotForRestore: sameConfigPath ? options.envSnapshotForRestore : undefined,
    unsetPaths: options.unsetPaths,
  });
}

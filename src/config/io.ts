import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";

import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import {
  DuplicateAgentDirError,
  findDuplicateAgentDirs,
} from "./agent-dirs.js";
import {
  applyContextPruningDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkApiKey,
} from "./defaults.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { resolveConfigPath, resolveStateDir } from "./paths.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import type {
  ClawdbotConfig,
  ConfigFileSnapshot,
  LegacyConfigIssue,
} from "./types.js";
import { validateConfigObject } from "./validation.js";
import { ClawdbotSchema } from "./zod-schema.js";

const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "CLAWDBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_PASSWORD",
];

export type ParseConfigJson5Result =
  | { ok: true; parsed: unknown }
  | { ok: false; error: string };

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
};

function warnOnConfigMiskeys(
  raw: unknown,
  logger: Pick<typeof console, "warn">,
): void {
  if (!raw || typeof raw !== "object") return;
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return;
  if ("token" in (gateway as Record<string, unknown>)) {
    logger.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

function applyConfigEnv(cfg: ClawdbotConfig, env: NodeJS.ProcessEnv): void {
  const envConfig = cfg.env;
  if (!envConfig) return;

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [key, value] of Object.entries(envConfig.vars)) {
      if (!value) continue;
      entries[key] = value;
    }
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (key === "shellEnv" || key === "vars") continue;
    if (typeof value !== "string" || !value.trim()) continue;
    entries[key] = value;
  }

  for (const [key, value] of Object.entries(entries)) {
    if (env[key]?.trim()) continue;
    env[key] = value;
  }
}

function resolveConfigPathForDeps(deps: Required<ConfigIoDeps>): string {
  if (deps.configPath) return deps.configPath;
  return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}

function normalizeDeps(overrides: ConfigIoDeps = {}): Required<ConfigIoDeps> {
  return {
    fs: overrides.fs ?? fs,
    json5: overrides.json5 ?? JSON5,
    env: overrides.env ?? process.env,
    homedir: overrides.homedir ?? os.homedir,
    configPath: overrides.configPath ?? "",
    logger: overrides.logger ?? console,
  };
}

export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: json5.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ============================================================================
// Config Includes ($include directive)
// ============================================================================

const INCLUDE_KEY = "$include";
const MAX_INCLUDE_DEPTH = 10;

export class ConfigIncludeError extends Error {
  constructor(
    message: string,
    public readonly includePath: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "ConfigIncludeError";
  }
}

export class CircularIncludeError extends ConfigIncludeError {
  constructor(
    public readonly chain: string[],
  ) {
    super(
      `Circular include detected: ${chain.join(" -> ")}`,
      chain[chain.length - 1],
    );
    this.name = "CircularIncludeError";
  }
}

type IncludeContext = {
  basePath: string;
  visited: Set<string>;
  depth: number;
  fsModule: typeof fs;
  json5Module: typeof JSON5;
  logger: Pick<typeof console, "error" | "warn">;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (key in result) {
        result[key] = deepMerge(result[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
  return source;
}

function resolveIncludePath(includePath: string, basePath: string): string {
  if (path.isAbsolute(includePath)) {
    return includePath;
  }
  const baseDir = path.dirname(basePath);
  return path.resolve(baseDir, includePath);
}

function loadIncludeFile(
  includePath: string,
  ctx: IncludeContext,
): unknown {
  const resolvedPath = resolveIncludePath(includePath, ctx.basePath);
  const normalizedPath = path.normalize(resolvedPath);

  // Check for circular includes
  if (ctx.visited.has(normalizedPath)) {
    throw new CircularIncludeError([...ctx.visited, normalizedPath]);
  }

  // Check depth limit
  if (ctx.depth >= MAX_INCLUDE_DEPTH) {
    throw new ConfigIncludeError(
      `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includePath}`,
      includePath,
    );
  }

  // Read and parse the file
  let raw: string;
  try {
    raw = ctx.fsModule.readFileSync(normalizedPath, "utf-8");
  } catch (err) {
    throw new ConfigIncludeError(
      `Failed to read include file: ${includePath} (resolved: ${normalizedPath})`,
      includePath,
      err instanceof Error ? err : undefined,
    );
  }

  let parsed: unknown;
  try {
    parsed = ctx.json5Module.parse(raw);
  } catch (err) {
    throw new ConfigIncludeError(
      `Failed to parse include file: ${includePath} (resolved: ${normalizedPath})`,
      includePath,
      err instanceof Error ? err : undefined,
    );
  }

  // Recursively resolve includes in the loaded file
  const newCtx: IncludeContext = {
    ...ctx,
    basePath: normalizedPath,
    visited: new Set([...ctx.visited, normalizedPath]),
    depth: ctx.depth + 1,
  };

  return resolveIncludes(parsed, newCtx);
}

function resolveIncludeDirective(
  includeValue: unknown,
  ctx: IncludeContext,
): unknown {
  if (typeof includeValue === "string") {
    // Single file include
    return loadIncludeFile(includeValue, ctx);
  }

  if (Array.isArray(includeValue)) {
    // Multiple files - deep merge them
    let result: unknown = {};
    for (const item of includeValue) {
      if (typeof item !== "string") {
        throw new ConfigIncludeError(
          `Invalid $include array item: expected string, got ${typeof item}`,
          String(item),
        );
      }
      const loaded = loadIncludeFile(item, ctx);
      result = deepMerge(result, loaded);
    }
    return result;
  }

  throw new ConfigIncludeError(
    `Invalid $include value: expected string or array of strings, got ${typeof includeValue}`,
    String(includeValue),
  );
}

/**
 * Recursively resolves $include directives in the config object.
 *
 * Supports:
 * - `{ "$include": "./path/to/file.json5" }` - replaces object with file contents
 * - `{ "$include": ["./a.json5", "./b.json5"] }` - deep merges multiple files
 * - Nested includes up to MAX_INCLUDE_DEPTH levels
 *
 * @example
 * ```json5
 * // clawdbot.json
 * {
 *   gateway: { port: 18789 },
 *   agents: { "$include": "./agents.json5" },
 *   broadcast: { "$include": ["./clients/a.json5", "./clients/b.json5"] }
 * }
 * ```
 */
export function resolveIncludes(
  obj: unknown,
  ctx: IncludeContext,
): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveIncludes(item, ctx));
  }

  if (isPlainObject(obj)) {
    // Check if this object is an include directive
    if (INCLUDE_KEY in obj) {
      const includeValue = obj[INCLUDE_KEY];
      const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);

      if (otherKeys.length > 0) {
        // Has other keys besides $include - merge include result with them
        const included = resolveIncludeDirective(includeValue, ctx);
        const rest: Record<string, unknown> = {};
        for (const key of otherKeys) {
          rest[key] = resolveIncludes(obj[key], ctx);
        }
        return deepMerge(included, rest);
      }

      // Pure include directive
      return resolveIncludeDirective(includeValue, ctx);
    }

    // Regular object - recurse into properties
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveIncludes(value, ctx);
    }
    return result;
  }

  // Primitives pass through unchanged
  return obj;
}

/**
 * Creates an include context for resolving $include directives.
 */
function createIncludeContext(
  configPath: string,
  deps: Required<ConfigIoDeps>,
): IncludeContext {
  return {
    basePath: configPath,
    visited: new Set([path.normalize(configPath)]),
    depth: 0,
    fsModule: deps.fs,
    json5Module: deps.json5,
    logger: deps.logger,
  };
}

export function createConfigIO(overrides: ConfigIoDeps = {}) {
  const deps = normalizeDeps(overrides);
  const configPath = resolveConfigPathForDeps(deps);

  function loadConfig(): ClawdbotConfig {
    try {
      if (!deps.fs.existsSync(configPath)) {
        if (shouldEnableShellEnvFallback(deps.env)) {
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

      // Resolve $include directives before validation
      const includeCtx = createIncludeContext(configPath, deps);
      const resolved = resolveIncludes(parsed, includeCtx);

      warnOnConfigMiskeys(resolved, deps.logger);
      if (typeof resolved !== "object" || resolved === null) return {};
      const validated = ClawdbotSchema.safeParse(resolved);
      if (!validated.success) {
        deps.logger.error("Invalid config:");
        for (const iss of validated.error.issues) {
          deps.logger.error(`- ${iss.path.join(".")}: ${iss.message}`);
        }
        return {};
      }
      const cfg = applyModelDefaults(
        applyContextPruningDefaults(
          applySessionDefaults(
            applyLoggingDefaults(
              applyMessageDefaults(validated.data as ClawdbotConfig),
            ),
          ),
        ),
      );

      const duplicates = findDuplicateAgentDirs(cfg, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (duplicates.length > 0) {
        throw new DuplicateAgentDirError(duplicates);
      }

      applyConfigEnv(cfg, deps.env);

      const enabled =
        shouldEnableShellEnvFallback(deps.env) ||
        cfg.env?.shellEnv?.enabled === true;
      if (enabled) {
        loadShellEnvFallback({
          enabled: true,
          env: deps.env,
          expectedKeys: SHELL_ENV_EXPECTED_KEYS,
          logger: deps.logger,
          timeoutMs:
            cfg.env?.shellEnv?.timeoutMs ??
            resolveShellEnvFallbackTimeoutMs(deps.env),
        });
      }

      return applyConfigOverrides(cfg);
    } catch (err) {
      if (err instanceof DuplicateAgentDirError) {
        deps.logger.error(err.message);
        throw err;
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      return {};
    }
  }

  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      const config = applyTalkApiKey(
        applyModelDefaults(
          applyContextPruningDefaults(
            applySessionDefaults(applyMessageDefaults({})),
          ),
        ),
      );
      const legacyIssues: LegacyConfigIssue[] = [];
      return {
        path: configPath,
        exists: false,
        raw: null,
        parsed: {},
        valid: true,
        config,
        issues: [],
        legacyIssues,
      };
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: {},
          valid: false,
          config: {},
          issues: [
            { path: "", message: `JSON5 parse failed: ${parsedRes.error}` },
          ],
          legacyIssues: [],
        };
      }

      // Resolve $include directives
      let resolved: unknown;
      try {
        const includeCtx = createIncludeContext(configPath, deps);
        resolved = resolveIncludes(parsedRes.parsed, includeCtx);
      } catch (err) {
        const message =
          err instanceof ConfigIncludeError
            ? err.message
            : `Include resolution failed: ${String(err)}`;
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          valid: false,
          config: {},
          issues: [{ path: "", message }],
          legacyIssues: [],
        };
      }

      const legacyIssues = findLegacyConfigIssues(resolved);

      const validated = validateConfigObject(resolved);
      if (!validated.ok) {
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          valid: false,
          config: {},
          issues: validated.issues,
          legacyIssues,
        };
      }

      return {
        path: configPath,
        exists: true,
        raw,
        parsed: parsedRes.parsed,
        valid: true,
        config: applyTalkApiKey(
          applyModelDefaults(
            applySessionDefaults(
              applyLoggingDefaults(applyMessageDefaults(validated.config)),
            ),
          ),
        ),
        issues: [],
        legacyIssues,
      };
    } catch (err) {
      return {
        path: configPath,
        exists: true,
        raw: null,
        parsed: {},
        valid: false,
        config: {},
        issues: [{ path: "", message: `read failed: ${String(err)}` }],
        legacyIssues: [],
      };
    }
  }

  async function writeConfigFile(cfg: ClawdbotConfig) {
    const dir = path.dirname(configPath);
    await deps.fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const json = JSON.stringify(applyModelDefaults(cfg), null, 2)
      .trimEnd()
      .concat("\n");

    const tmp = path.join(
      dir,
      `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    await deps.fs.promises.writeFile(tmp, json, {
      encoding: "utf-8",
      mode: 0o600,
    });

    await deps.fs.promises
      .copyFile(configPath, `${configPath}.bak`)
      .catch(() => {
        // best-effort
      });

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
        return;
      }
      await deps.fs.promises.unlink(tmp).catch(() => {
        // best-effort
      });
      throw err;
    }
  }

  return {
    configPath,
    loadConfig,
    readConfigFileSnapshot,
    writeConfigFile,
  };
}

// NOTE: These wrappers intentionally do *not* cache the resolved config path at
// module scope. `CLAWDBOT_CONFIG_PATH` (and friends) are expected to work even
// when set after the module has been imported (tests, one-off scripts, etc.).
export function loadConfig(): ClawdbotConfig {
  return createConfigIO({ configPath: resolveConfigPath() }).loadConfig();
}

export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    configPath: resolveConfigPath(),
  }).readConfigFileSnapshot();
}

export async function writeConfigFile(cfg: ClawdbotConfig): Promise<void> {
  await createConfigIO({ configPath: resolveConfigPath() }).writeConfigFile(
    cfg,
  );
}

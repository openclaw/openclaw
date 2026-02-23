import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BotConfig } from "./types.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "../infra/home-dir.js";

/**
 * Nix mode detection: When BOT_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export function resolveIsNixMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BOT_NIX_MODE === "1";
}

export const isNixMode = resolveIsNixMode();

const STATE_DIRNAME = ".bot";
const CONFIG_FILENAME = "bot.json";

function resolveDefaultHomeDir(): string {
  return resolveRequiredHomeDir(process.env, os.homedir);
}

/** Build a homedir thunk that respects BOT_HOME for the given env. */
function envHomedir(env: NodeJS.ProcessEnv): () => string {
  return () => resolveRequiredHomeDir(env, os.homedir);
}

function stateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return path.join(homedir(), STATE_DIRNAME);
}

export function resolveLegacyStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return stateDir(homedir);
}

export function resolveLegacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return [stateDir(homedir)];
}

export function resolveNewStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return stateDir(homedir);
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via BOT_STATE_DIR.
 * Default: ~/.bot
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.BOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  return stateDir(effectiveHomedir);
}

function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(env, homedir),
      env,
      homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export const STATE_DIR = resolveStateDir();

/**
 * Config file path.
 * Can be overridden via BOT_CONFIG_PATH.
 * Default: ~/.bot/bot.json (or $BOT_STATE_DIR/bot.json)
 */
export function resolveCanonicalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.BOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(dir, CONFIG_FILENAME);
}

/**
 * Resolve the active config path, checking if it exists on disk.
 */
export function resolveConfigPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const candidates = resolveDefaultConfigCandidates(env, homedir);
  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
}

/**
 * Active config path.
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = resolveStateDir(env, envHomedir(env)),
  homedir: () => string = envHomedir(env),
): string {
  const override = env.BOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  const configPath = path.join(dir, CONFIG_FILENAME);
  try {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  } catch {
    // fall through
  }
  const stateOverride = env.BOT_STATE_DIR?.trim();
  if (stateOverride) {
    return configPath;
  }
  const defaultDir = resolveStateDir(env, homedir);
  if (path.resolve(dir) === path.resolve(defaultDir)) {
    return resolveConfigPathCandidate(env, homedir);
  }
  return configPath;
}

/**
 * @deprecated Use resolveConfigPathCandidate() instead. This constant is evaluated
 * at module load time and does not respect BOT_HOME set after import.
 */
export const CONFIG_PATH = resolveConfigPathCandidate();

/**
 * Runtime-evaluated config path that respects BOT_HOME.
 * Use this instead of CONFIG_PATH when BOT_HOME may be set dynamically.
 */
export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfigPathCandidate(env, envHomedir(env));
}

/**
 * Resolve default config path candidates.
 * Order: explicit config path → state dir config → default.
 */
export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string[] {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const explicit = env.BOT_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit, env, effectiveHomedir)];
  }

  const candidates: string[] = [];
  const botStateDir = env.BOT_STATE_DIR?.trim();
  if (botStateDir) {
    const resolved = resolveUserPath(botStateDir, env, effectiveHomedir);
    candidates.push(path.join(resolved, CONFIG_FILENAME));
  }

  candidates.push(path.join(stateDir(effectiveHomedir), CONFIG_FILENAME));
  return candidates;
}

export const DEFAULT_GATEWAY_PORT = 18789;

/**
 * Gateway lock directory (ephemeral).
 * Default: os.tmpdir()/bot-<uid> (uid suffix when available).
 */
export function resolveGatewayLockDir(tmpdir: () => string = os.tmpdir): string {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `bot-${uid}` : "bot";
  return path.join(base, suffix);
}

const OAUTH_FILENAME = "oauth.json";

/**
 * OAuth credentials storage directory.
 *
 * Precedence:
 * - `BOT_OAUTH_DIR` (explicit override)
 * - `$BOT_STATE_DIR/credentials` (canonical default)
 */
export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.BOT_OAUTH_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(dir, "credentials");
}

export function resolveOAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = resolveStateDir(env, envHomedir(env)),
): string {
  return path.join(resolveOAuthDir(env, dir), OAUTH_FILENAME);
}

export function resolveGatewayPort(cfg?: BotConfig, env: NodeJS.ProcessEnv = process.env): number {
  const isIsolatedInstance = Boolean(env.BOT_HOME?.trim());

  const configPort = cfg?.gateway?.port;
  if (
    isIsolatedInstance &&
    typeof configPort === "number" &&
    Number.isFinite(configPort) &&
    configPort > 0
  ) {
    return configPort;
  }

  const envRaw = env.BOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }

  return DEFAULT_GATEWAY_PORT;
}

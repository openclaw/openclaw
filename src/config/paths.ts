import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHomeRelativePath, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { CLAWORKS_STANDARD_GATEWAY_PORT } from "./claworks-gateway.js";
import type { OpenClawConfig } from "./types.js";

/**
 * Nix mode detection: When OPENCLAW_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export function resolveIsNixMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_NIX_MODE === "1";
}

export const isNixMode = resolveIsNixMode();

// Support the remaining legacy pre-rebrand state dir.
const LEGACY_STATE_DIRNAMES = [".clawdbot"] as const;
const NEW_STATE_DIRNAME = ".openclaw";
const CLAWORKS_STATE_DIRNAME = ".claworks";
const CONFIG_FILENAME = "openclaw.json";
const CLAWORKS_CONFIG_FILENAME = "claworks.json";

export function isClaworksProduct(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAWORKS_PRODUCT === "1";
}

function resolveProductStateDirname(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksProduct(env) ? CLAWORKS_STATE_DIRNAME : NEW_STATE_DIRNAME;
}

function resolveProductConfigFilename(env: NodeJS.ProcessEnv = process.env): string {
  return isClaworksProduct(env) ? CLAWORKS_CONFIG_FILENAME : CONFIG_FILENAME;
}
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json"] as const;

function resolveDefaultHomeDir(): string {
  return resolveRequiredHomeDir(process.env, os.homedir);
}

/** Build a homedir thunk that respects OPENCLAW_HOME for the given env. */
function envHomedir(env: NodeJS.ProcessEnv): () => string {
  return () => resolveRequiredHomeDir(env, os.homedir);
}

function legacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}

function newStateDir(
  homedir: () => string = resolveDefaultHomeDir,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(homedir(), resolveProductStateDirname(env));
}

export function resolveLegacyStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return legacyStateDirs(homedir)[0] ?? newStateDir(homedir);
}

export function resolveLegacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return legacyStateDirs(homedir);
}

export function resolveNewStateDir(
  homedir: () => string = resolveDefaultHomeDir,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return newStateDir(homedir, env);
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Override precedence (ClaWorks mode): CLAWORKS_STATE_DIR → OPENCLAW_STATE_DIR → default ~/.claworks
 * Override precedence (OpenClaw mode): OPENCLAW_STATE_DIR → default ~/.openclaw
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  // In ClaWorks product mode, honour CLAWORKS_STATE_DIR as the first-class override.
  const override =
    (isClaworksProduct(env) ? env.CLAWORKS_STATE_DIR?.trim() : undefined) ||
    env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  const newDir = newStateDir(effectiveHomedir, env);
  if (env.OPENCLAW_TEST_FAST === "1") {
    return newDir;
  }
  const legacyDirs = legacyStateDirs(effectiveHomedir);
  const hasNew = fs.existsSync(newDir);
  if (hasNew) {
    return newDir;
  }
  const existingLegacy = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  if (existingLegacy) {
    return existingLegacy;
  }
  return newDir;
}

function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  return resolveHomeRelativePath(input, { env, homedir });
}

/**
 * Optional allowlist of directories that `$include` directives may resolve
 * outside the config directory. Set via `OPENCLAW_INCLUDE_ROOTS` as a
 * platform-delimited path list (`:` on POSIX, `;` on Windows).
 *
 * Each entry is tilde-expanded and resolved to an absolute path. Entries that
 * cannot be resolved or that are not absolute after expansion are dropped.
 *
 * Returns an empty array when the var is unset or contains no usable entries,
 * preserving the historical behavior where `$include` is confined to the
 * directory containing `openclaw.json`.
 */
export function resolveIncludeRoots(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string[] {
  const raw = env.OPENCLAW_INCLUDE_ROOTS?.trim();
  if (!raw) {
    return [];
  }
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of raw.split(path.delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(
      resolveHomeRelativePath(trimmed, { env, homedir: effectiveHomedir }),
    );
    if (!path.isAbsolute(resolved) || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

export const STATE_DIR = resolveStateDir();

/**
 * Config file path (JSON or JSON5).
 * Override precedence (ClaWorks mode): CLAWORKS_CONFIG → OPENCLAW_CONFIG_PATH → default claworks.json
 * Override precedence (OpenClaw mode): OPENCLAW_CONFIG_PATH → default openclaw.json
 */
export function resolveCanonicalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override =
    (isClaworksProduct(env) ? env.CLAWORKS_CONFIG?.trim() : undefined) ||
    env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, resolveProductConfigFilename(env));
}

/**
 * Resolve the active config path by preferring existing config candidates
 * before falling back to the canonical path.
 */
export function resolveConfigPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  if (env.OPENCLAW_TEST_FAST === "1") {
    return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir));
  }
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
 * Active config path (prefers existing config files).
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
  homedir: () => string = envHomedir(env),
): string {
  const override =
    (isClaworksProduct(env) ? env.CLAWORKS_CONFIG?.trim() : undefined) ||
    env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  if (env.OPENCLAW_TEST_FAST === "1") {
    return path.join(stateDir, resolveProductConfigFilename(env));
  }
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  const configFilename = resolveProductConfigFilename(env);
  const candidates = [
    path.join(stateDir, configFilename),
    ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name)),
  ];
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
  if (stateOverride) {
    return path.join(stateDir, configFilename);
  }
  const defaultStateDir = resolveStateDir(env, homedir);
  if (path.resolve(stateDir) === path.resolve(defaultStateDir)) {
    return resolveConfigPathCandidate(env, homedir);
  }
  return path.join(stateDir, configFilename);
}

export const CONFIG_PATH = resolveConfigPathCandidate();

/**
 * Resolve default config path candidates across default locations.
 * Order: explicit config path → state-dir-derived paths → new default.
 */
export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string[] {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const explicit =
    (isClaworksProduct(env) ? env.CLAWORKS_CONFIG?.trim() : undefined) ||
    env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit, env, effectiveHomedir)];
  }

  const candidates: string[] = [];
  const openclawStateDir =
    (isClaworksProduct(env) ? env.CLAWORKS_STATE_DIR?.trim() : undefined) ||
    env.OPENCLAW_STATE_DIR?.trim();
  const configFilename = resolveProductConfigFilename(env);
  if (openclawStateDir) {
    const resolved = resolveUserPath(openclawStateDir, env, effectiveHomedir);
    candidates.push(path.join(resolved, configFilename));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
  }

  const defaultDirs = [newStateDir(effectiveHomedir, env), ...legacyStateDirs(effectiveHomedir)];
  for (const dir of defaultDirs) {
    candidates.push(path.join(dir, configFilename));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
  }
  return candidates;
}

export const DEFAULT_GATEWAY_PORT = 18789;

/**
 * Gateway lock directory (ephemeral).
 * Default: os.tmpdir()/openclaw-<uid> (uid suffix when available).
 */
export function resolveGatewayLockDir(
  tmpdir: () => string = os.tmpdir,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const product = isClaworksProduct(env) ? "claworks" : "openclaw";
  const suffix = uid != null ? `${product}-${uid}` : product;
  return path.join(base, suffix);
}

const OAUTH_FILENAME = "oauth.json";

/**
 * OAuth credentials storage directory.
 *
 * Precedence:
 * - `OPENCLAW_OAUTH_DIR` (explicit override)
 * - `$*_STATE_DIR/credentials` (canonical server/default)
 */
export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, "credentials");
}

export function resolveOAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  return path.join(resolveOAuthDir(env, stateDir), OAUTH_FILENAME);
}

function parseGatewayPortEnvValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  // Docker Compose publish strings can leak into host CLI env loading via repo `.env`,
  // for example `127.0.0.1:18789` or `[::1]:18789`. Accept only explicit host:port forms.
  const bracketedIpv6Match = trimmed.match(/^\[[^\]]+\]:(\d+)$/);
  if (bracketedIpv6Match?.[1]) {
    const parsed = Number.parseInt(bracketedIpv6Match[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon <= 0 || firstColon !== lastColon) {
    return null;
  }
  const suffix = trimmed.slice(firstColon + 1);
  if (!/^\d+$/.test(suffix)) {
    return null;
  }
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveGatewayPort(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim();
  const envPort = parseGatewayPortEnvValue(envRaw);
  if (envPort !== null) {
    return envPort;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) {
      return configPort;
    }
  }
  if (isClaworksProduct(env)) {
    return CLAWORKS_STANDARD_GATEWAY_PORT;
  }
  return DEFAULT_GATEWAY_PORT;
}

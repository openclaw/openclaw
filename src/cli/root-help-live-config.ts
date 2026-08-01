// Root-help config probe for plugin-sensitive help rendering.
import fs from "node:fs";
import path from "node:path";
import { resolveRequiredHomeDir, resolveUserPath } from "../infra/home-dir.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";

/** Env vars that can change which plugins root help renders. */
const PLUGIN_ENV_KEYS = [
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function hasListEntries(value: string[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

type PluginsConfigShape =
  | {
      enabled?: boolean;
      allow?: string[];
      deny?: string[];
      load?: { paths?: string[] };
      slots?: object;
      entries?: object;
      installs?: object;
    }
  | undefined;

function pluginsAffectHelp(plugins: PluginsConfigShape): boolean {
  return Boolean(
    plugins &&
    (plugins.enabled === false ||
      hasListEntries(plugins.allow) ||
      hasListEntries(plugins.deny) ||
      hasListEntries(plugins.load?.paths) ||
      hasEntries(plugins.slots) ||
      hasEntries(plugins.entries) ||
      hasEntries(plugins.installs)),
  );
}

function envAffectsPluginHelp(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim() || env.OPENCLAW_DISABLE_BUNDLED_PLUGINS?.trim(),
  );
}

/**
 * Config dir as `resolveConfigDir` computes it, without importing the config
 * module. Kept deliberately in step with `src/utils.ts`.
 */
function configDirForProbe(env: NodeJS.ProcessEnv): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return resolveUserPath(stateOverride, env);
  }
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return path.dirname(resolveUserPath(configPath, env));
  }
  return path.join(resolveRequiredHomeDir(env), ".openclaw");
}

function configPathsForProbe(env: NodeJS.ProcessEnv): string[] {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return [resolveUserPath(override, env)];
  }
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    const stateDir = resolveUserPath(stateOverride, env);
    return [path.join(stateDir, "openclaw.json"), path.join(stateDir, "clawdbot.json")];
  }
  const home = resolveRequiredHomeDir(env);
  return [
    path.join(home, ".openclaw", "openclaw.json"),
    path.join(home, ".openclaw", "clawdbot.json"),
    path.join(home, ".clawdbot", "openclaw.json"),
    path.join(home, ".clawdbot", "clawdbot.json"),
  ];
}

function readFirstConfigText(env: NodeJS.ProcessEnv): string | null | undefined {
  for (const candidate of configPathsForProbe(env)) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return undefined;
      }
    }
  }
  return null;
}

/**
 * The dotenv files the config read would load, in the same order and under the
 * same state-dir condition as `loadGlobalRuntimeDotEnvFiles`. Reading the config
 * has the side effect of loading these, so the fast path must account for them
 * before it can skip that read.
 */
function dotEnvPathsForProbe(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  try {
    paths.push(path.join(process.cwd(), ".env"));
  } catch {
    // Deleted cwd: nothing to read.
  }
  const configDir = configDirForProbe(env);
  const stateEnvPath = path.join(configDir, ".env");
  paths.push(stateEnvPath);
  const home = resolveRequiredHomeDir(env);
  const defaultStateEnvPath = path.join(home, ".openclaw", ".env");
  const hasExplicitNonDefaultStateDir =
    env.OPENCLAW_STATE_DIR?.trim() !== undefined &&
    path.resolve(stateEnvPath) !== path.resolve(defaultStateEnvPath);
  if (!hasExplicitNonDefaultStateDir) {
    paths.push(path.join(home, ".config", "openclaw", "gateway.env"));
  }
  return [...new Set(paths)];
}

function anyDotEnvMentionsPluginKey(env: NodeJS.ProcessEnv): boolean {
  for (const dotEnvPath of dotEnvPathsForProbe(env)) {
    let text: string;
    try {
      text = fs.readFileSync(dotEnvPath, "utf8");
    } catch {
      continue;
    }
    if (PLUGIN_ENV_KEYS.some((key) => text.includes(key))) {
      return true;
    }
  }
  return false;
}

/**
 * True only when the on-disk config provably cannot affect plugin help.
 * Anything the cheap read cannot decide - JSON5 syntax, an include directive, an
 * env-var reference - returns false so the caller takes the full config path.
 */
function configCannotAffectPluginHelp(env: NodeJS.ProcessEnv): boolean {
  const raw = readFirstConfigText(env);
  if (raw === null) {
    return true;
  }
  if (raw === undefined) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  // Inspect the decoded representation so JSON escapes cannot hide loader-owned
  // include or environment-substitution syntax from this lightweight probe.
  const decoded = JSON.stringify(parsed);
  if (decoded.includes("$include") || decoded.includes("${") || decoded.includes("$(")) {
    return false;
  }
  return !pluginsAffectHelp((parsed as { plugins?: PluginsConfigShape }).plugins);
}

/** Load render options only when config/env can affect plugin help output. */
export async function loadRootHelpRenderOptionsForConfigSensitivePlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootHelpRenderOptions | null> {
  // Fast path: when nothing reachable through the config file, the dotenv files
  // the config read would load, or the process env can change plugin help, the
  // answer is `null` regardless, so the config module never has to be loaded.
  //
  // Only the real environment is probed. An injected env is a test/diagnostic
  // sandbox that must stay isolated from the host filesystem - the same rule
  // `maybeLoadDotEnvForConfig` applies before it loads dotenv files - so those
  // callers keep taking the full config path.
  if (
    env === process.env &&
    !envAffectsPluginHelp(env) &&
    !anyDotEnvMentionsPluginKey(env) &&
    configCannotAffectPluginHelp(env)
  ) {
    return null;
  }
  const configModule = await import("../config/config.js");
  const snapshot = await configModule.readConfigFileSnapshot({
    observe: false,
    skipPluginValidation: true,
  });
  if (!snapshot.valid) {
    return null;
  }
  const configAffectsPluginHelp = pluginsAffectHelp(snapshot.sourceConfig.plugins);
  if (!envAffectsPluginHelp(env) && !configAffectsPluginHelp) {
    return null;
  }
  return {
    config: snapshot.runtimeConfig,
    env,
  };
}

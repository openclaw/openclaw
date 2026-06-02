import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function hasListEntries(value: string[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

export function hasPluginHelpAffectingConfig(config: OpenClawConfig | null | undefined): boolean {
  const plugins = config?.plugins;
  if (!plugins) {
    return false;
  }
  return (
    plugins.enabled === false ||
    hasListEntries(plugins.allow) ||
    hasListEntries(plugins.deny) ||
    hasListEntries(plugins.load?.paths) ||
    hasEntries(plugins.slots) ||
    hasEntries(plugins.entries) ||
    hasEntries(plugins.installs)
  );
}

export function hasPluginHelpAffectingEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim() || env.OPENCLAW_DISABLE_BUNDLED_PLUGINS?.trim(),
  );
}

function hasPotentialDotEnv(env: NodeJS.ProcessEnv): boolean {
  try {
    if (fs.existsSync(path.join(process.cwd(), ".env"))) {
      return true;
    }
    if (fs.existsSync(path.join(resolveStateDir(env), ".env"))) {
      return true;
    }
    if (hasConfigPathDotEnv(env)) {
      return true;
    }
    return hasLegacyGatewayDotEnv(env);
  } catch {
    return true;
  }
}

function hasConfigPathDotEnv(env: NodeJS.ProcessEnv): boolean {
  if (!env.OPENCLAW_CONFIG_PATH?.trim()) {
    return false;
  }
  return fs.existsSync(
    path.join(path.dirname(resolveConfigPath(env, resolveStateDir(env))), ".env"),
  );
}

function hasExplicitNonDefaultStateDir(env: NodeJS.ProcessEnv): boolean {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (!override) {
    return false;
  }
  const homeDir = resolveRequiredHomeDir(env, os.homedir);
  const stateDir = resolveStateDir(env, () => homeDir);
  const defaultStateDir = path.join(homeDir, ".openclaw");
  return path.resolve(stateDir) !== path.resolve(defaultStateDir);
}

function hasLegacyGatewayDotEnv(env: NodeJS.ProcessEnv): boolean {
  if (hasExplicitNonDefaultStateDir(env)) {
    return false;
  }
  const homeDir = resolveRequiredHomeDir(env, os.homedir);
  return fs.existsSync(path.join(homeDir, ".config", "openclaw", "gateway.env"));
}

function hasConfigFile(env: NodeJS.ProcessEnv): boolean {
  try {
    return fs.existsSync(resolveConfigPath(env, resolveStateDir(env)));
  } catch {
    return true;
  }
}

export async function loadRootHelpRenderOptionsForConfigSensitivePlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootHelpRenderOptions | null> {
  if (
    env === process.env &&
    !hasPluginHelpAffectingEnv(env) &&
    !hasPotentialDotEnv(env) &&
    !hasConfigFile(env)
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
  if (!hasPluginHelpAffectingEnv(env) && !hasPluginHelpAffectingConfig(snapshot.sourceConfig)) {
    return null;
  }
  return {
    config: snapshot.runtimeConfig,
    env,
  };
}

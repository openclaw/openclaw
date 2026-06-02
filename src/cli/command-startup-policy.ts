import { isTruthyEnvValue } from "../infra/env.js";
import type { CliCommandPluginLoadPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

/** Return whether a command path can run before config guard validation. */
export function shouldBypassConfigGuardForCommandPath(commandPath: string[]): boolean {
  return resolveCliCommandPathPolicy(commandPath).bypassConfigGuard;
}

/** Return whether route-mode startup should skip config guard output for this command. */
export function shouldSkipRouteConfigGuardForCommandPath(params: {
  commandPath: string[];
  suppressDoctorStdout: boolean;
}): boolean {
  const routeConfigGuard = resolveCliCommandPathPolicy(params.commandPath).routeConfigGuard;
  return (
    routeConfigGuard === "always" ||
    (routeConfigGuard === "when-suppressed" && params.suppressDoctorStdout)
  );
}

/** Decide whether a command path needs plugins loaded before execution. */
export function shouldLoadPluginsForCommandPath(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode: boolean;
}): boolean {
  return shouldLoadPlugins({
    loadPlugins: resolveCliCommandPathPolicy(params.commandPath).loadPlugins,
    argv: params.argv,
    commandPath: params.commandPath,
    jsonOutputMode: params.jsonOutputMode,
  });
}

function shouldLoadPlugins(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode: boolean;
  loadPlugins: CliCommandPluginLoadPolicy;
}): boolean {
  const loadPlugins = params.loadPlugins;
  if (typeof loadPlugins === "function") {
    return loadPlugins({
      argv: params.argv ?? [],
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
    });
  }
  return loadPlugins === "always" || (loadPlugins === "text-only" && !params.jsonOutputMode);
}

/** Return whether banner output should be hidden for this command path/environment. */
export function shouldHideCliBannerForCommandPath(
  commandPath: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER) ||
    resolveCliCommandPathPolicy(commandPath).hideBanner
  );
}

/** Return whether startup should ensure the `openclaw` binary is on PATH for this command. */
export function shouldEnsureCliPathForCommandPath(commandPath: string[]): boolean {
  return commandPath.length === 0 || resolveCliCommandPathPolicy(commandPath).ensureCliPath;
}

/** Resolve the early startup policy consumed before command handlers run. */
export function resolveCliStartupPolicy(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  const suppressDoctorStdout = params.jsonOutputMode;
  const commandPolicy = resolveCliCommandPathPolicy(params.commandPath);
  const env = params.env ?? process.env;
  return {
    suppressDoctorStdout,
    hideBanner: isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER) || commandPolicy.hideBanner,
    skipConfigGuard: params.routeMode
      ? commandPolicy.routeConfigGuard === "always" ||
        (commandPolicy.routeConfigGuard === "when-suppressed" && suppressDoctorStdout)
      : false,
    loadPlugins: shouldLoadPlugins({
      argv: params.argv,
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
      loadPlugins: commandPolicy.loadPlugins,
    }),
    pluginRegistry: commandPolicy.pluginRegistry,
  };
}

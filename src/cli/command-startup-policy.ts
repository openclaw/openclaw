import { isTruthyEnvValue } from "../infra/env.js";
import type { CliCommandPluginLoadPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

/** Reports whether a command can run before config is readable or valid. */
export function shouldBypassConfigGuardForCommandPath(commandPath: string[]): boolean {
  return resolveCliCommandPathPolicy(commandPath).bypassConfigGuard;
}

/** Reports whether route-first startup should skip config repair output for this command. */
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

/** Resolves whether startup should preload plugins before command dispatch. */
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
    // Dynamic policies need argv because some commands only need plugins for local execution.
    return loadPlugins({
      argv: params.argv ?? [],
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
    });
  }
  return loadPlugins === "always" || (loadPlugins === "text-only" && !params.jsonOutputMode);
}

/** Reports whether the startup banner should be hidden for a command/env pair. */
export function shouldHideCliBannerForCommandPath(
  commandPath: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER) ||
    resolveCliCommandPathPolicy(commandPath).hideBanner
  );
}

/** Reports whether startup should ensure the openclaw executable is discoverable on PATH. */
export function shouldEnsureCliPathForCommandPath(commandPath: string[]): boolean {
  return commandPath.length === 0 || resolveCliCommandPathPolicy(commandPath).ensureCliPath;
}

/** Aggregates command startup policy for route-first and Commander-based entry points. */
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

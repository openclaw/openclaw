import { isTruthyEnvValue } from "../infra/env.js";

const PLUGIN_REQUIRED_COMMANDS = new Set([
  "agent",
  "message",
  "channels",
  "directory",
  "agents",
  "configure",
  "status",
  "health",
]);

const CONFIG_GUARD_BYPASS_COMMANDS = new Set(["backup", "doctor", "completion", "secrets"]);

export function shouldBypassConfigGuardForCommandPath(commandPath: string[]): boolean {
  const [primary, secondary] = commandPath;
  if (!primary) {
    return false;
  }
  if (CONFIG_GUARD_BYPASS_COMMANDS.has(primary)) {
    return true;
  }
  return primary === "config" && (secondary === "validate" || secondary === "schema");
}

export function shouldSkipRouteConfigGuardForCommandPath(params: {
  commandPath: string[];
  suppressDoctorStdout: boolean;
}): boolean {
  return (
    (params.commandPath[0] === "status" && params.suppressDoctorStdout) ||
    (params.commandPath[0] === "gateway" && params.commandPath[1] === "status")
  );
}

export function shouldLoadPluginsForCommandPath(params: {
  commandPath: string[];
  jsonOutputMode: boolean;
}): boolean {
  const [primary, secondary] = params.commandPath;
  if (!primary || !PLUGIN_REQUIRED_COMMANDS.has(primary)) {
    return false;
  }
  if ((primary === "status" || primary === "health") && params.jsonOutputMode) {
    return false;
  }
  return !(primary === "onboard" || (primary === "channels" && secondary === "add"));
}

export function shouldHideCliBannerForCommandPath(
  commandPath: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER) ||
    commandPath[0] === "update" ||
    commandPath[0] === "completion" ||
    (commandPath[0] === "plugins" && commandPath[1] === "update")
  );
}

export function shouldEnsureCliPathForCommandPath(commandPath: string[]): boolean {
  const [primary, secondary] = commandPath;
  if (!primary) {
    return true;
  }
  if (primary === "status" || primary === "health" || primary === "sessions") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  return true;
}

export function resolveCliStartupPolicy(params: {
  commandPath: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  const suppressDoctorStdout = params.jsonOutputMode;
  return {
    suppressDoctorStdout,
    hideBanner: shouldHideCliBannerForCommandPath(params.commandPath, params.env),
    skipConfigGuard: params.routeMode
      ? shouldSkipRouteConfigGuardForCommandPath({
          commandPath: params.commandPath,
          suppressDoctorStdout,
        })
      : false,
    loadPlugins: shouldLoadPluginsForCommandPath({
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
    }),
  };
}

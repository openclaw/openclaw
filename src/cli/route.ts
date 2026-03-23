import { isTruthyEnvValue } from "../infra/env.js";
import { loggingState } from "../logging/state.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { getCommandPathWithRootOptions, hasFlag, hasHelpOrVersion } from "./argv.js";
import { emitCliBanner } from "./banner.js";
import { findRoutedCommand } from "./program/routes.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean | ((argv: string[]) => boolean);
}) {
  const suppressDoctorStdout = hasFlag(params.argv, "--json");
  emitCliBanner(VERSION, { argv: params.argv });
  const { ensureConfigReady } = await import("./program/config-guard.js");
  await ensureConfigReady({
    runtime: defaultRuntime,
    commandPath: params.commandPath,
    ...(suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
  });
  const shouldLoadPlugins =
    typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;
  if (shouldLoadPlugins) {
    const { ensurePluginRegistryLoaded } = await import("./plugin-registry.js");
    const prev = loggingState.forceConsoleToStderr;
    if (suppressDoctorStdout) {
      loggingState.forceConsoleToStderr = true;
    }
    try {
      ensurePluginRegistryLoaded({
        scope:
          params.commandPath[0] === "status" || params.commandPath[0] === "health"
            ? "channels"
            : "all",
      });
    } finally {
      loggingState.forceConsoleToStderr = prev;
    }
  }
}

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  if (hasHelpOrVersion(argv)) {
    return false;
  }

  const path = getCommandPathWithRootOptions(argv, 2);
  if (!path[0]) {
    return false;
  }
  const route = findRoutedCommand(path);
  if (!route) {
    return false;
  }
  await prepareRoutedCommand({ argv, commandPath: path, loadPlugins: route.loadPlugins });
  return route.run(argv);
}

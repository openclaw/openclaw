import { isTruthyEnvValue } from "../infra/env.js";
import { getCommandPath, hasHelpOrVersion } from "./argv.js";
import { findRoutedCommand } from "./program/command-registry.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean;
}) {
  const { VERSION } = await import("../version.js");
  const { emitCliBanner } = await import("./banner.js");
  const { defaultRuntime } = await import("../runtime.js");
  const { ensureConfigReady } = await import("./program/config-guard.js");
  emitCliBanner(VERSION, { argv: params.argv });
  await ensureConfigReady({ runtime: defaultRuntime, commandPath: params.commandPath });
  if (params.loadPlugins) {
    const { ensurePluginRegistryLoaded } = await import("./plugin-registry.js");
    ensurePluginRegistryLoaded();
  }
}

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  if (hasHelpOrVersion(argv)) {
    return false;
  }

  const path = getCommandPath(argv, 2);
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

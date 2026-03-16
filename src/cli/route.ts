import { isTruthyEnvValue } from "../infra/env.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { getCommandPathWithRootOptions, hasFlag, hasHelpOrVersion } from "./argv.js";
import { prepareCliExecution } from "./program/prepare-cli-execution.js";
import { findRoutedCommand } from "./program/routes.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean | ((argv: string[]) => boolean);
}) {
  const shouldLoadPlugins =
    typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;
  await prepareCliExecution({
    argv: params.argv,
    commandPath: params.commandPath,
    runtime: defaultRuntime,
    bannerVersion: VERSION,
    loadPlugins: shouldLoadPlugins,
    pluginScope:
      shouldLoadPlugins &&
      (params.commandPath[0] === "status" || params.commandPath[0] === "health")
        ? "channels"
        : shouldLoadPlugins
          ? "all"
          : undefined,
    suppressDoctorStdout: hasFlag(params.argv, "--json"),
  });
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

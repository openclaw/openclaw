import { routeLogsToStderr } from "../logging/console.js";
import type { RuntimeInterface } from "../runtime.js";
import { getCommandPathWithRootOptions } from "./argv.js";
import { ensureCliCommandBootstrap } from "./command-bootstrap.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

type CliStartupPolicy = ReturnType<typeof resolveCliStartupPolicy>;

export function resolveCliExecutionStartupContext(params: {
  argv: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  const commandPath = getCommandPathWithRootOptions(params.argv, 2);
  return {
    commandPath,
    startupPolicy: resolveCliStartupPolicy({
      commandPath,
      jsonOutputMode: params.jsonOutputMode,
      env: params.env,
      routeMode: params.routeMode,
    }),
  };
}

export async function applyCliExecutionStartupPresentation(params: {
  argv?: string[];
  routeLogsToStderrOnSuppress?: boolean;
  startupPolicy: CliStartupPolicy;
  showBanner?: boolean;
  version?: string;
}) {
  if (params.startupPolicy.suppressDoctorStdout && params.routeLogsToStderrOnSuppress !== false) {
    routeLogsToStderr();
  }
  if (params.startupPolicy.hideBanner || params.showBanner === false || !params.version) {
    return;
  }
  const { emitCliBanner } = await import("./banner.js");
  if (params.argv) {
    emitCliBanner(params.version, { argv: params.argv });
    return;
  }
  emitCliBanner(params.version);
}

export async function ensureCliExecutionBootstrap(params: {
  runtime: RuntimeInterface;
  commandPath: string[];
  startupPolicy: CliStartupPolicy;
  allowInvalid?: boolean;
  loadPlugins?: boolean;
  skipConfigGuard?: boolean;
}) {
  await ensureCliCommandBootstrap({
    runtime: params.runtime,
    commandPath: params.commandPath,
    suppressDoctorStdout: params.startupPolicy.suppressDoctorStdout,
    allowInvalid: params.allowInvalid,
    loadPlugins: params.loadPlugins ?? params.startupPolicy.loadPlugins,
    skipConfigGuard: params.skipConfigGuard ?? params.startupPolicy.skipConfigGuard,
  });
}

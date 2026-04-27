import type { RuntimeEnv } from "../runtime.js";
import {
  ensureCliPluginRegistryLoaded,
  resolvePluginRegistryScopeForCommandPath,
} from "./plugin-registry-loader.js";

let configGuardModulePromise: Promise<typeof import("./program/config-guard.js")> | undefined;

function loadConfigGuardModule() {
  configGuardModulePromise ??= import("./program/config-guard.js");
  return configGuardModulePromise;
}

export async function ensureCliCommandBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  suppressDoctorStdout?: boolean;
  skipConfigGuard?: boolean;
  allowInvalid?: boolean;
  loadPlugins?: boolean;
}) {
  if (!params.skipConfigGuard) {
    const { ensureConfigReady } = await loadConfigGuardModule();
    await ensureConfigReady({
      runtime: params.runtime,
      commandPath: params.commandPath,
      ...(params.allowInvalid ? { allowInvalid: true } : {}),
      ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
    });
  }
  if (!params.loadPlugins) {
    return;
  }
  await ensureCliPluginRegistryLoaded({
    scope: resolvePluginRegistryScopeForCommandPath(params.commandPath),
    routeLogsToStderr: params.suppressDoctorStdout,
  });
}

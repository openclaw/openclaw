// Shared command preflight: config readiness plus optional plugin registry activation.
import type { ConfigFileSnapshot } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { CliPluginRegistryPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";
import { handlePermissionError } from "./permission-error-handler";

const configGuardModuleLoader = createLazyImportLoader(() => import("./program/config-guard.js"));

function loadConfigGuardModule() {
  return configGuardModuleLoader.load();
}

/** Run the lazy command bootstrap steps selected by command policy. */
export async function ensureCliCommandBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  suppressDoctorStdout?: boolean;
  skipConfigGuard?: boolean;
  allowInvalid?: boolean;
  beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
  loadPlugins?: boolean;
  pluginRegistry?: CliPluginRegistryPolicy;
}) {
  if (!params.skipConfigGuard) {
    const { ensureConfigReady } = await loadConfigGuardModule();
    await ensureConfigReady({
      runtime: params.runtime,
      commandPath: params.commandPath,
      ...(params.allowInvalid ? { allowInvalid: true } : {}),
      ...(params.beforeStateMigrations
        ? { beforeStateMigrations: params.beforeStateMigrations }
        : {}),
      ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
    });
  }
  if (!params.loadPlugins) {
    return;
  }
  const pluginRegistryLoadPolicy =
    params.pluginRegistry ?? resolveCliCommandPathPolicy(params.commandPath).pluginRegistry;
  await ensureCliPluginRegistryLoaded({
    scope: pluginRegistryLoadPolicy.scope,
    routeLogsToStderr: params.suppressDoctorStdout,
  });
}

process.on("uncaughtException", (err) => {
  const handled = handlePermissionError(err);
  if (!handled) {
    console.error("Uncaught Exception:", err);
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const handled = handlePermissionError(reason as Error);
  if (!handled) {
    console.error("Unhandled Rejection:", reason);
  }
});

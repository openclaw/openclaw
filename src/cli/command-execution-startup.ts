// CLI startup presentation and config-before-plugin bootstrap.
import type { ConfigFileSnapshot } from "../config/types.js";
import { routeLogsToStderr } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

type CliStartupPolicy = ReturnType<typeof resolveCliStartupPolicy>;

const configGuardModuleLoader = createLazyImportLoader(() => import("./program/config-guard.js"));

const hasJsonFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V");

export async function applyCliExecutionStartupPresentation(params: {
  argv?: string[];
  routeLogsToStderrOnSuppress?: boolean;
  startupPolicy: CliStartupPolicy;
  showBanner?: boolean;
  version?: string;
}) {
  // Machine-readable commands must route diagnostics away before startup can print.
  if (params.startupPolicy.suppressDoctorStdout && params.routeLogsToStderrOnSuppress !== false) {
    routeLogsToStderr();
  }
  if (params.startupPolicy.hideBanner || params.showBanner === false || !params.version) {
    return;
  }
  if (params.argv && (hasJsonFlag(params.argv) || hasVersionFlag(params.argv))) {
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
  runtime: RuntimeEnv;
  commandPath: string[];
  startupPolicy: CliStartupPolicy;
  allowInvalid?: boolean;
  beforeStatePreparation?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
  loadPlugins?: boolean;
  skipConfigGuard?: boolean;
  validateConfigOnly?: boolean;
}) {
  const { runtime, commandPath, startupPolicy, allowInvalid, beforeStatePreparation } = params;
  const { suppressDoctorStdout, pluginRegistry } = startupPolicy;
  const loadPlugins = params.loadPlugins ?? startupPolicy.loadPlugins;
  const skipConfigGuard = params.skipConfigGuard ?? startupPolicy.skipConfigGuard;
  const validateConfigOnly = params.validateConfigOnly ?? startupPolicy.validateConfigOnly;
  if (!skipConfigGuard) {
    await measureCliCommandStartup("config-ready", async () => {
      const { ensureConfigReady } = await configGuardModuleLoader.load();
      const runConfigGuard = () =>
        ensureConfigReady({
          runtime,
          commandPath,
          measure: (stage, run) => measureCliCommandStartup(stage, run),
          ...(allowInvalid ? { allowInvalid: true } : {}),
          ...(validateConfigOnly ? { validateConfigOnly: true } : {}),
          ...(beforeStatePreparation ? { beforeStatePreparation } : {}),
          ...(suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
        });
      const nativeGatewayBootstrap =
        commandPath[0] === "gateway" &&
        (commandPath.length === 1 || (commandPath.length === 2 && commandPath[1] === "run"));
      if (nativeGatewayBootstrap && !validateConfigOnly) {
        const [
          { withConfigSnapshotPreparation },
          { prepareHostConfigSnapshot },
          { resolveConfigPath },
        ] = await Promise.all([
          import("../config/io.snapshot-preparation-scope.js"),
          import("../config/io.snapshot-preparation.js"),
          import("../config/paths.js"),
        ]);
        await withConfigSnapshotPreparation(
          { configPath: resolveConfigPath(), prepare: prepareHostConfigSnapshot },
          runConfigGuard,
        );
      } else {
        await runConfigGuard();
      }
    });
  }
  if (!loadPlugins) {
    return;
  }
  await measureCliCommandStartup("plugin-registry", () =>
    ensureCliPluginRegistryLoaded({
      scope: pluginRegistry.scope,
      routeLogsToStderr: suppressDoctorStdout,
    }),
  );
}

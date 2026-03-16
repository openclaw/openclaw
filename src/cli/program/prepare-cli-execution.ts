import type { RuntimeEnv } from "../../runtime.js";
import { emitCliBanner } from "../banner.js";
import { ensurePluginRegistryLoaded, type PluginRegistryScope } from "../plugin-registry.js";
import { ensureConfigReady } from "./config-guard.js";

export type CliPluginLoadPolicy = boolean | ((argv: string[]) => boolean) | undefined;

export type PrepareCliExecutionParams = {
  argv: string[];
  commandPath: string[];
  runtime: RuntimeEnv;
  bannerVersion?: string;
  hideBanner?: boolean;
  loadPlugins?: CliPluginLoadPolicy;
  pluginScope?: PluginRegistryScope;
  suppressDoctorStdout?: boolean;
};

function shouldLoadPlugins(policy: CliPluginLoadPolicy, argv: string[]): boolean {
  if (typeof policy === "function") {
    return policy(argv);
  }
  return policy === true;
}

/**
 * Shared CLI preflight path used by both route-first and Commander preAction flows.
 * Keeping this in one place prevents config/plugin prep drift between execution paths.
 */
export async function prepareCliExecution(params: PrepareCliExecutionParams): Promise<void> {
  if (!params.hideBanner && params.bannerVersion) {
    emitCliBanner(params.bannerVersion, { argv: params.argv });
  }

  await ensureConfigReady({
    runtime: params.runtime,
    commandPath: params.commandPath,
    ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
  });

  if (shouldLoadPlugins(params.loadPlugins, params.argv)) {
    ensurePluginRegistryLoaded({ scope: params.pluginScope ?? "all" });
  }
}

// Runtime config helpers expose scoped OpenClaw config reads to plugin runtimes.
import { getRuntimeConfig } from "../../config/config.js";
import {
  mutateConfigFile as mutateConfigFileInternal,
  replaceConfigFile as replaceConfigFileInternal,
} from "../../config/mutate.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { logWarn } from "../../logger.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

const RUNTIME_CONFIG_LOAD_WRITE_COMPAT_CODE = "runtime-config-load-write";

const MAX_WARNED_DEPRECATED_CONFIG_APIS = 4096;
// Warning state spans fresh config snapshots; bounding it means evicted plugin keys can re-warn.
const warnedDeprecatedConfigApis = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_WARNED_DEPRECATED_CONFIG_APIS,
});

function formatDeprecatedConfigApiSubject(name: "loadConfig" | "writeConfigFile"): string {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope?.pluginId) {
    return `plugin runtime config.${name}()`;
  }
  return `plugin "${scope.pluginId}" runtime config.${name}()`;
}

function formatDeprecatedConfigApiSource(): string {
  const scope = getPluginRuntimeGatewayRequestScope();
  return scope?.pluginSource ? ` Source: ${scope.pluginSource}` : "";
}

function formatDeprecatedConfigApiWarningKey(name: "loadConfig" | "writeConfigFile"): string {
  const scope = getPluginRuntimeGatewayRequestScope();
  return `${name}:${scope?.pluginId ?? "anonymous"}`;
}

function warnDeprecatedConfigApiOnce(
  name: "loadConfig" | "writeConfigFile",
  replacement: string,
): void {
  const warningKey = formatDeprecatedConfigApiWarningKey(name);
  if (warnedDeprecatedConfigApis.check(warningKey)) {
    return;
  }
  logWarn(
    `${formatDeprecatedConfigApiSubject(name)} is deprecated (${RUNTIME_CONFIG_LOAD_WRITE_COMPAT_CODE}); use ${replacement}.${formatDeprecatedConfigApiSource()}`,
  );
}

/** @internal Test-only reset for the runtime config compatibility warning cache. */
export function resetRuntimeConfigDeprecationWarningStateForTest(): void {
  warnedDeprecatedConfigApis.clear();
}

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    current: getRuntimeConfig,
    mutateConfigFile: async (params) =>
      await mutateConfigFileInternal({
        ...params,
        writeOptions: params.writeOptions,
      }),
    replaceConfigFile: async (params) =>
      await replaceConfigFileInternal({
        ...params,
        writeOptions: params.writeOptions,
      }),
    loadConfig: () => {
      warnDeprecatedConfigApiOnce("loadConfig", "config.current()");
      return getRuntimeConfig();
    },
    writeConfigFile: async (cfg, options) => {
      warnDeprecatedConfigApiOnce(
        "writeConfigFile",
        "config.mutateConfigFile(...) or config.replaceConfigFile(...)",
      );
      await replaceConfigFileInternal({
        nextConfig: cfg,
        afterWrite: options?.afterWrite ?? { mode: "auto" },
        writeOptions: options,
      });
    },
  };
}

import { warnSessionPersistenceDeprecation } from "../agents/sessions/session-persistence-deprecation.js";
import { loadConfig } from "../config/io.runtime.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";

/** @deprecated Use readRuntimeConfig after awaiting captureRuntimeConfigAsyncReader()(). Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function getRuntimeConfig(options?: Parameters<typeof loadConfig>[0]) {
  warnSessionPersistenceDeprecation(
    "getRuntimeConfig",
    "readRuntimeConfig after awaiting captureRuntimeConfigAsyncReader()()",
    {
      pluginId: pluginInstanceInvocation.getStore()?.instance.pluginId,
      family: "runtime-config",
    },
  );
  return loadConfig(options);
}

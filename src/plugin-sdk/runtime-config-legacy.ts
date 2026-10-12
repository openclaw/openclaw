import { warnSessionPersistenceDeprecation } from "../agents/sessions/session-persistence-deprecation.js";
import { loadConfig } from "../config/io.runtime.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";

/** @deprecated Use readRuntimeConfig after awaiting captureRuntimeConfigAsyncReader()(). */
export function getRuntimeConfig(options?: Parameters<typeof loadConfig>[0]) {
  warnSessionPersistenceDeprecation("getRuntimeConfig", "readRuntimeConfig", {
    pluginId: pluginInstanceInvocation.getStore()?.instance.pluginId,
    family: "runtime-config",
  });
  return loadConfig(options);
}

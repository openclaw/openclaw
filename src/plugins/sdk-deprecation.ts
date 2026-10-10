import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getPluginExecutionFrame } from "./plugin-instance-invocation.js";
import { getPluginRegistryState } from "./runtime-state.js";
import { getPluginRuntimeExecutionFrame } from "./runtime/execution-frame.js";

// Source imports and SDK bundles share the budget, including across plugin reloads.
const warned = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSdkDeprecations"),
  () => new Set<string>(),
);

/** Call only at a legacy operation, with static capability and migration descriptions. */
export function warnPluginSdkDeprecation(params: {
  family: string;
  method: string;
  replacement: string;
  pluginId?: string;
  compatibility?: string;
  code?: string;
}): void {
  const frame = getPluginExecutionFrame();
  const candidate =
    params.pluginId ??
    frame?.invocation?.instance.pluginId ??
    getPluginRegistryState()?.registrationContext?.pluginId ??
    getPluginRuntimeExecutionFrame(frame)?.gatewayScope?.pluginId;
  // An unscoped consumer must not turn a path or arbitrary label into a diagnostic.
  const pluginId =
    candidate &&
    candidate.length <= 128 &&
    /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/iu.test(candidate)
      ? candidate
      : undefined;
  const key = JSON.stringify([pluginId ?? null, params.family]);
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  process.emitWarning(
    `${pluginId ? `Plugin ${pluginId}` : "Plugin SDK"}: ${params.method} is deprecated; use ${params.replacement} instead. ${params.compatibility ?? "The legacy contract remains supported in the current Plugin SDK major."} It will be removed in the next Plugin SDK major.`,
    { code: params.code ?? "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
  );
}

import type { OpenClawPluginApi } from "./types.js";

type FunctionPropertyNames<T> = Extract<
  {
    [K in keyof T]-?: Exclude<T[K], undefined> extends (...args: unknown[]) => unknown ? K : never;
  }[keyof T],
  string
>;

export type PluginApiMethodName = FunctionPropertyNames<OpenClawPluginApi>;

/** Lifecycle contract for plugin API methods after registration finishes. */
export type PluginApiLifecyclePolicy = {
  phase: "registration" | "runtime";
  lateCallable: boolean;
};

const PLUGIN_API_METHOD_POLICIES: Partial<Record<PluginApiMethodName, PluginApiLifecyclePolicy>> = {
  // Runtime callbacks are safe after registration; most registration methods
  // remain registration-only and intentionally have no late-call policy.
  emitAgentEvent: { phase: "runtime", lateCallable: true },
  sendSessionAttachment: { phase: "runtime", lateCallable: true },
  scheduleSessionTurn: { phase: "runtime", lateCallable: true },
  unscheduleSessionTurnsByTag: { phase: "runtime", lateCallable: true },
};

/** Returns lifecycle metadata for a plugin API method when it has special handling. */
export function getPluginApiMethodLifecyclePolicy(
  methodName: string,
): PluginApiLifecyclePolicy | undefined {
  return PLUGIN_API_METHOD_POLICIES[methodName as PluginApiMethodName];
}

/** Type guard for plugin API methods that may be called after registration. */
export function isLateCallablePluginApiMethod(
  methodName: string,
): methodName is PluginApiMethodName {
  return getPluginApiMethodLifecyclePolicy(methodName)?.lateCallable === true;
}

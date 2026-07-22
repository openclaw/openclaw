/** Tracks plugin API lifecycle callbacks registered during runtime activation. */

type PluginApiLifecyclePolicy = {
  phase: "registration" | "runtime";
  lateCallable: boolean;
};

const PLUGIN_API_METHOD_POLICIES = {
  emitAgentEvent: { phase: "runtime", lateCallable: true },
  sendSessionAttachment: { phase: "runtime", lateCallable: true },
  scheduleSessionTurn: { phase: "runtime", lateCallable: true },
  unscheduleSessionTurnsByTag: { phase: "runtime", lateCallable: true },
} as const satisfies Record<string, PluginApiLifecyclePolicy>;

type LateCallablePluginApiMethod = keyof typeof PLUGIN_API_METHOD_POLICIES;

/** Returns lifecycle policy for one plugin API method name. */
function getPluginApiMethodLifecyclePolicy(
  methodName: string,
): PluginApiLifecyclePolicy | undefined {
  return Object.hasOwn(PLUGIN_API_METHOD_POLICIES, methodName)
    ? PLUGIN_API_METHOD_POLICIES[methodName as LateCallablePluginApiMethod]
    : undefined;
}

/** True when a plugin API method remains callable after registration. */
export function isLateCallablePluginApiMethod(
  methodName: string,
): methodName is LateCallablePluginApiMethod {
  return getPluginApiMethodLifecyclePolicy(methodName)?.lateCallable === true;
}

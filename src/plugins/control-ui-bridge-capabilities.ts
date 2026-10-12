import { normalizePluginHostHookId, type PluginControlUiDescriptor } from "./host-hooks.js";

type NormalizedControlUiBridgeCapabilities = Pick<PluginControlUiDescriptor, "sessionActions">;

export function normalizeControlUiBridgeCapabilities(
  descriptor: PluginControlUiDescriptor,
): NormalizedControlUiBridgeCapabilities | null {
  const rawActions = descriptor.sessionActions;
  if (rawActions !== undefined && !Array.isArray(rawActions)) {
    return null;
  }
  const sessionActions = rawActions?.map((actionId) =>
    typeof actionId === "string" ? normalizePluginHostHookId(actionId) : "",
  );
  if (
    sessionActions?.some((actionId) => !actionId) ||
    (descriptor.surface !== "tab" && (sessionActions?.length ?? 0) > 0)
  ) {
    return null;
  }
  return {
    ...(sessionActions !== undefined ? { sessionActions: [...new Set(sessionActions)] } : {}),
  };
}

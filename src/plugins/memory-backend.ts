import type { PluginRegistrationMode } from "./plugin-registration.types.js";

/**
 * Whether an opted-in memory plugin that does not own the slot loads as a passive backend
 * instead of being disabled. Slot "none" has no owner to serve, and only loads that register
 * memory capabilities for the owner qualify.
 */
export function isMemoryBackendRequested(
  entry: { memoryBackend?: boolean } | undefined,
  memorySlot: string | null | undefined,
  pluginId: string,
  mode: PluginRegistrationMode,
): boolean {
  return (
    entry?.memoryBackend === true &&
    typeof memorySlot === "string" &&
    memorySlot !== pluginId &&
    (mode === "full" || mode === "discovery")
  );
}

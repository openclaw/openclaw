/** Stores active web-tool metadata for the secrets runtime snapshot. */
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

let activeRuntimeWebToolsMetadata: RuntimeWebToolsMetadata | null = null;

/**
 * Clears active web-tool metadata when the secrets runtime snapshot is reset.
 */
export function clearActiveRuntimeWebToolsMetadata(): void {
  activeRuntimeWebToolsMetadata = null;
}

/**
 * Stores metadata owned by the active secrets runtime snapshot.
 */
export function setActiveRuntimeWebToolsMetadata(metadata: RuntimeWebToolsMetadata): void {
  activeRuntimeWebToolsMetadata = metadata;
}

/**
 * Returns active web-tool metadata without exposing mutable runtime state.
 */
export function getActiveRuntimeWebToolsMetadataFromState(): RuntimeWebToolsMetadata | null {
  if (!activeRuntimeWebToolsMetadata) {
    return null;
  }
  return structuredClone(activeRuntimeWebToolsMetadata);
}

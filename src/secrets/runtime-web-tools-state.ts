import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

let activeRuntimeWebToolsMetadata: RuntimeWebToolsMetadata | null = null;

export function clearActiveRuntimeWebToolsMetadata(): void {
  activeRuntimeWebToolsMetadata = null;
}

export function setActiveRuntimeWebToolsMetadata(metadata: RuntimeWebToolsMetadata): void {
  activeRuntimeWebToolsMetadata = structuredClone(metadata);
}

export function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null {
  if (!activeRuntimeWebToolsMetadata) {
    return null;
  }
  return structuredClone(activeRuntimeWebToolsMetadata);
}

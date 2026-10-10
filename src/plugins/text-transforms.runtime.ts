import { mergePluginTextTransforms } from "../agents/plugin-text-transforms.js";
import { getActiveRuntimePluginRegistry } from "./active-runtime-registry.js";
import type { PluginTextTransforms } from "./types.js";

/** Resolves merged text transforms from the active runtime plugin registry. */
export function resolveRuntimeTextTransforms(): PluginTextTransforms | undefined {
  return mergePluginTextTransforms(
    ...(getActiveRuntimePluginRegistry()?.textTransforms.map((entry) => entry.transforms) ?? []),
  );
}

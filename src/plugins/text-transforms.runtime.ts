import { mergePluginTextTransforms } from "../agents/plugin-text-transforms.js";
import { getActiveRuntimePluginRegistry } from "./active-runtime-registry.js";
import type { PluginTextTransforms } from "./types.js";

export function resolveRuntimeTextTransforms(): PluginTextTransforms | undefined {
  return mergePluginTextTransforms(
    ...(getActiveRuntimePluginRegistry()?.textTransforms.map((entry) => entry.transforms) ?? []),
  );
}

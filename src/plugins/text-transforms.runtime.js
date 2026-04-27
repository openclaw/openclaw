import { mergePluginTextTransforms } from "../agents/plugin-text-transforms.js";
import { getActiveRuntimePluginRegistry } from "./active-runtime-registry.js";
export function resolveRuntimeTextTransforms() {
    const registry = getActiveRuntimePluginRegistry();
    const pluginTextTransforms = Array.isArray(registry?.textTransforms)
        ? registry.textTransforms.map((entry) => entry.transforms)
        : [];
    return mergePluginTextTransforms(...pluginTextTransforms);
}

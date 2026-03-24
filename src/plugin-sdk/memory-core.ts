// Narrow plugin-sdk surface for the bundled memory-core plugin.
// Keep this list additive and scoped to symbols used under extensions/memory-core.

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { MemoryPromptSectionBuilder } from "../memory/prompt-section.js";
export type { OpenClawPluginApi } from "../plugins/types.js";

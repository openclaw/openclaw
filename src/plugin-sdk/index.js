// Shared root plugin-sdk surface.
// Keep this entry intentionally tiny. Channel/provider helpers belong on
// dedicated subpaths or, for legacy consumers, the compat surface.
export * from "./image-generation.js";
export * from "./music-generation.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { registerContextEngine } from "../context-engine/registry.js";
export { buildMemorySystemPromptAddition, delegateCompactionToRuntime, } from "../context-engine/delegate.js";
export { onDiagnosticEvent } from "../infra/diagnostic-events.js";

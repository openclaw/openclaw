// Dynamic-import boundary: this file is the only entry point for lazy callers.
// plugin-registry.ts is statically imported from route.ts; keeping it out of
// any dynamic import() target ensures the bundler emits a single shared module
// instance and avoids the static-vs-dynamic double-registration hazard.
// See CLAUDE.md: "Dynamic import guardrail".
export { ensurePluginRegistryLoaded } from "./plugin-registry.js";

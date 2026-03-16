export * from "./internal-hooks.js";

export type HookEventType = import("./internal-hooks.js").InternalHookEventType;
export type HookEvent = import("./internal-hooks.js").InternalHookEvent;
export type HookHandler = import("./internal-hook-types.js").InternalHookHandler;
export type EnrichHookHandler = import("./internal-hooks.js").InternalEnrichHookHandler;
export type { MessageEnrichResult } from "./internal-hooks.js";

export {
  registerInternalHook as registerHook,
  unregisterInternalHook as unregisterHook,
  registerInternalEnrichHook as registerEnrichHook,
  unregisterInternalEnrichHook as unregisterEnrichHook,
  clearInternalHooks as clearHooks,
  getRegisteredEventKeys as getRegisteredHookEventKeys,
  triggerInternalHook as triggerHook,
  triggerEnrichHook,
  hasEnrichHooks,
  createInternalHookEvent as createHookEvent,
} from "./internal-hooks.js";

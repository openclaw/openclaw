export * from "./internal-hooks.js";
export * from "./shell-hooks.js";
export * from "./agent-hooks-config.js";

export type HookEventType = import("./internal-hooks.js").InternalHookEventType;
export type HookEvent = import("./internal-hooks.js").InternalHookEvent;
export type HookHandler = import("./internal-hooks.js").InternalHookHandler;
export type HookHandlerWithOutput = import("./internal-hooks.js").InternalHookHandlerWithOutput;

export {
  registerInternalHook as registerHook,
  unregisterInternalHook as unregisterHook,
  clearInternalHooks as clearHooks,
  getRegisteredEventKeys as getRegisteredHookEventKeys,
  triggerInternalHook as triggerHook,
  triggerInternalHookWithOutput as triggerHookWithOutput,
  createInternalHookEvent as createHookEvent,
  registerInternalHookWithOutput as registerHookWithOutput,
  unregisterInternalHookWithOutput as unregisterHookWithOutput,
} from "./internal-hooks.js";

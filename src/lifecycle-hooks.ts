/**
 * Lifecycle Hooks System
 * 
 * Provides minimal hooks at key points in the gateway execution path:
 * - agent:dispatch - fires before agent spawn/dispatch
 * - agent:handoff - fires after producer output, before consumer input
 * - memory:retrieve - fires after memory fetch, before results returned
 * 
 * These hooks are optional, additive, and non-breaking.
 */

import { createSubsystemLogger } from "./logging/subsystem.js";

const log = createSubsystemLogger("lifecycle-hooks");

// Hook types
export const LIFECYCLE_HOOKS = [
  "agent:dispatch",
  "agent:handoff",
  "memory:retrieve",
] as const;

export type LifecycleHookName = (typeof LIFECYCLE_HOOKS)[number];

// Context types for each hook
export type AgentDispatchContext = {
  sessionKey: string;
  taskId?: string;
  agentId: string;
  contextKeys?: string[];
  runtime?: string;
  mode?: string;
};

export type AgentHandoffContext = {
  sessionKey: string;
  taskId?: string;
  producerAgent: string;
  consumerAgent: string;
  payload: unknown;
  handoffMetadata?: Record<string, unknown>;
};

export type MemoryRetrieveContext = {
  sessionKey?: string;
  agentId?: string;
  query: string;
  results: Array<{
    snippet: string;
    score: number;
    source?: string;
    path?: string;
  }>;
};

// Union type for context
export type LifecycleHookContext = 
  | { type: "agent:dispatch"; context: AgentDispatchContext }
  | { type: "agent:handoff"; context: AgentHandoffContext }
  | { type: "memory:retrieve"; context: MemoryRetrieveContext };

// Handler type
export type LifecycleHookHandler<T extends LifecycleHookName> = (
  context: T extends "agent:dispatch" ? AgentDispatchContext
    : T extends "agent:handoff" ? AgentHandoffContext
    : T extends "memory:retrieve" ? MemoryRetrieveContext
    : never
) => void | Promise<void>;

// Internal registry
type HookEntry = {
  handler: LifecycleHookHandler<any>;
  options?: {
    async?: boolean;
  };
};

const hookRegistry = new Map<LifecycleHookName, Set<HookEntry>>();

// Initialize registries
for (const hookName of LIFECYCLE_HOOKS) {
  hookRegistry.set(hookName, new Set());
}

/**
 * Register a handler for a lifecycle hook
 */
export function registerLifecycleHook<T extends LifecycleHookName>(
  hook: T,
  handler: LifecycleHookHandler<T>,
  options?: { async?: boolean }
): void {
  const handlers = hookRegistry.get(hook);
  if (!handlers) {
    log.warn(`Unknown hook: ${hook}`);
    return;
  }
  handlers.add({ handler, options });
  log.info(`Registered handler for hook: ${hook}`);
}

/**
 * Unregister a handler
 */
export function unregisterLifecycleHook<T extends LifecycleHookName>(
  hook: T,
  handler: LifecycleHookHandler<T>
): void {
  const handlers = hookRegistry.get(hook);
  if (!handlers) return;
  
  for (const entry of handlers) {
    if (entry.handler === handler) {
      handlers.delete(entry);
      log.info(`Unregistered handler for hook: ${hook}`);
      return;
    }
  }
}

/**
 * Emit a lifecycle hook
 * Handlers are called synchronously by default for minimal performance impact
 */
export async function emitLifecycleHook<T extends LifecycleHookName>(
  hook: T,
  context: T extends "agent:dispatch" ? AgentDispatchContext
    : T extends "agent:handoff" ? AgentHandoffContext
    : T extends "memory:retrieve" ? MemoryRetrieveContext
    : never
): Promise<void> {
  const handlers = hookRegistry.get(hook);
  if (!handlers || handlers.size === 0) {
    return; // No handlers registered, no-op
  }
  
  log.debug(`Emitting hook: ${hook}`, { contextKeys: 'contextKeys' in context ? context.contextKeys : undefined });
  
  for (const entry of handlers) {
    try {
      const result = entry.handler(context);
      if (result instanceof Promise) {
        if (entry.options?.async) {
          await result;
        } else {
          // Swallow promise rejections for non-async handlers - don't break execution
          result.catch((err) => {
            log.error(`Hook handler error for ${hook}:`, err);
          });
        }
      }
    } catch (err) {
      log.error(`Hook handler error for ${hook}:`, err);
      // Hook errors should not break execution
    }
  }
}

/**
 * Check if any handlers are registered for a hook
 */
export function hasLifecycleHookListeners(hook: LifecycleHookName): boolean {
  const handlers = hookRegistry.get(hook);
  return handlers ? handlers.size > 0 : false;
}

/**
 * Get list of registered hooks (for debugging)
 */
export function getRegisteredHooks(): LifecycleHookName[] {
  const registered: LifecycleHookName[] = [];
  for (const [hook, handlers] of hookRegistry) {
    if (handlers.size > 0) {
      registered.push(hook);
    }
  }
  return registered;
}

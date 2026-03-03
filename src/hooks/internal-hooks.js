/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
/** Registry of hook handlers by event key */
const handlers = new Map();
const log = createSubsystemLogger("internal-hooks");
/**
 * Register a hook handler for a specific event type or event:action combination
 *
 * @param eventKey - Event type (e.g., 'command') or specific action (e.g., 'command:new')
 * @param handler - Function to call when the event is triggered
 *
 * @example
 * ```ts
 * // Listen to all command events
 * registerInternalHook('command', async (event) => {
 *   console.log('Command:', event.action);
 * });
 *
 * // Listen only to /new commands
 * registerInternalHook('command:new', async (event) => {
 *   await saveSessionToMemory(event);
 * });
 * ```
 */
export function registerInternalHook(eventKey, handler) {
    if (!handlers.has(eventKey)) {
        handlers.set(eventKey, []);
    }
    handlers.get(eventKey).push(handler);
}
/**
 * Unregister a specific hook handler
 *
 * @param eventKey - Event key the handler was registered for
 * @param handler - The handler function to remove
 */
export function unregisterInternalHook(eventKey, handler) {
    const eventHandlers = handlers.get(eventKey);
    if (!eventHandlers) {
        return;
    }
    const index = eventHandlers.indexOf(handler);
    if (index !== -1) {
        eventHandlers.splice(index, 1);
    }
    // Clean up empty handler arrays
    if (eventHandlers.length === 0) {
        handlers.delete(eventKey);
    }
}
/**
 * Clear all registered hooks (useful for testing)
 */
export function clearInternalHooks() {
    handlers.clear();
}
/**
 * Get all registered event keys (useful for debugging)
 */
export function getRegisteredEventKeys() {
    return Array.from(handlers.keys());
}
/**
 * Trigger a hook event
 *
 * Calls all handlers registered for:
 * 1. The general event type (e.g., 'command')
 * 2. The specific event:action combination (e.g., 'command:new')
 *
 * Handlers are called in registration order. Errors are caught and logged
 * but don't prevent other handlers from running.
 *
 * @param event - The event to trigger
 */
export async function triggerInternalHook(event) {
    const typeHandlers = handlers.get(event.type) ?? [];
    const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
    const allHandlers = [...typeHandlers, ...specificHandlers];
    if (allHandlers.length === 0) {
        return;
    }
    for (const handler of allHandlers) {
        try {
            await handler(event);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
        }
    }
}
/**
 * Create a hook event with common fields filled in
 *
 * @param type - The event type
 * @param action - The action within that type
 * @param sessionKey - The session key
 * @param context - Additional context
 */
export function createInternalHookEvent(type, action, sessionKey, context = {}) {
    return {
        type,
        action,
        sessionKey,
        context,
        timestamp: new Date(),
        messages: [],
    };
}
export function isAgentBootstrapEvent(event) {
    if (event.type !== "agent" || event.action !== "bootstrap") {
        return false;
    }
    const context = event.context;
    if (!context || typeof context !== "object") {
        return false;
    }
    if (typeof context.workspaceDir !== "string") {
        return false;
    }
    return Array.isArray(context.bootstrapFiles);
}
export function isGatewayStartupEvent(event) {
    if (event.type !== "gateway" || event.action !== "startup") {
        return false;
    }
    const context = event.context;
    return Boolean(context && typeof context === "object");
}
export function isMessageReceivedEvent(event) {
    if (event.type !== "message" || event.action !== "received") {
        return false;
    }
    const context = event.context;
    if (!context || typeof context !== "object") {
        return false;
    }
    return typeof context.from === "string" && typeof context.channelId === "string";
}
export function isMessageSentEvent(event) {
    if (event.type !== "message" || event.action !== "sent") {
        return false;
    }
    const context = event.context;
    if (!context || typeof context !== "object") {
        return false;
    }
    return (typeof context.to === "string" &&
        typeof context.channelId === "string" &&
        typeof context.success === "boolean");
}

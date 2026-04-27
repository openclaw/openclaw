/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
/**
 * Registry of hook handlers by event key.
 *
 * Uses a globalThis singleton so that registerInternalHook and
 * triggerInternalHook always share the same Map even when the bundler
 * emits multiple copies of this module into separate chunks (bundle
 * splitting). Without the singleton, handlers registered in one chunk
 * are invisible to triggerInternalHook in another chunk, causing hooks
 * to silently fire with zero handlers.
 */
const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");
const handlers = resolveGlobalSingleton(INTERNAL_HOOK_HANDLERS_KEY, () => new Map());
const INTERNAL_HOOKS_ENABLED_KEY = Symbol.for("openclaw.internalHooksEnabled");
const internalHooksEnabledState = resolveGlobalSingleton(INTERNAL_HOOKS_ENABLED_KEY, () => ({ enabled: true }));
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
export function setInternalHooksEnabled(enabled) {
    internalHooksEnabledState.enabled = enabled;
}
/**
 * Get all registered event keys (useful for debugging)
 */
export function getRegisteredEventKeys() {
    return Array.from(handlers.keys());
}
export function hasInternalHookListeners(type, action) {
    return ((handlers.get(type)?.length ?? 0) > 0 || (handlers.get(`${type}:${action}`)?.length ?? 0) > 0);
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
    if (!internalHooksEnabledState.enabled) {
        return;
    }
    if (!hasInternalHookListeners(event.type, event.action)) {
        return;
    }
    const typeHandlers = handlers.get(event.type) ?? [];
    const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
    const allHandlers = [...typeHandlers, ...specificHandlers];
    for (const handler of allHandlers) {
        try {
            await handler(event);
        }
        catch (err) {
            const message = formatErrorMessage(err);
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
function isHookEventTypeAndAction(event, type, action) {
    return event.type === type && event.action === action;
}
function getHookContext(event) {
    const context = event.context;
    if (!context || typeof context !== "object") {
        return null;
    }
    return context;
}
function hasStringContextField(context, key) {
    return typeof context[key] === "string";
}
function hasBooleanContextField(context, key) {
    return typeof context[key] === "boolean";
}
export function isAgentBootstrapEvent(event) {
    if (!isHookEventTypeAndAction(event, "agent", "bootstrap")) {
        return false;
    }
    const context = getHookContext(event);
    if (!context) {
        return false;
    }
    if (!hasStringContextField(context, "workspaceDir")) {
        return false;
    }
    return Array.isArray(context.bootstrapFiles);
}
export function isGatewayStartupEvent(event) {
    if (!isHookEventTypeAndAction(event, "gateway", "startup")) {
        return false;
    }
    return Boolean(getHookContext(event));
}
export function isMessageReceivedEvent(event) {
    if (!isHookEventTypeAndAction(event, "message", "received")) {
        return false;
    }
    const context = getHookContext(event);
    if (!context) {
        return false;
    }
    return hasStringContextField(context, "from") && hasStringContextField(context, "channelId");
}
export function isMessageSentEvent(event) {
    if (!isHookEventTypeAndAction(event, "message", "sent")) {
        return false;
    }
    const context = getHookContext(event);
    if (!context) {
        return false;
    }
    return (hasStringContextField(context, "to") &&
        hasStringContextField(context, "channelId") &&
        hasBooleanContextField(context, "success"));
}
export function isMessageTranscribedEvent(event) {
    if (!isHookEventTypeAndAction(event, "message", "transcribed")) {
        return false;
    }
    const context = getHookContext(event);
    if (!context) {
        return false;
    }
    return (hasStringContextField(context, "transcript") && hasStringContextField(context, "channelId"));
}
export function isMessagePreprocessedEvent(event) {
    if (!isHookEventTypeAndAction(event, "message", "preprocessed")) {
        return false;
    }
    const context = getHookContext(event);
    if (!context) {
        return false;
    }
    return hasStringContextField(context, "channelId");
}
export function isSessionPatchEvent(event) {
    if (!isHookEventTypeAndAction(event, "session", "patch")) {
        return false;
    }
    const context = getHookContext(event);
    if (!context) {
        return false;
    }
    return (typeof context.patch === "object" &&
        context.patch !== null &&
        typeof context.cfg === "object" &&
        context.cfg !== null &&
        typeof context.sessionEntry === "object" &&
        context.sessionEntry !== null);
}

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getActivePluginRegistry,
  getPluginRegistrationContext,
  requireActivePluginRegistry,
} from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  InternalHookEvent,
  InternalHookEventType,
  InternalHookHandler,
} from "./internal-hook-types.js";
export type { InternalHookEvent, InternalHookEventType, InternalHookHandler };

// Share registrations across copies of this module emitted into separate bundle chunks.
const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");
const handlers = resolveGlobalSingleton<Map<string, InternalHookHandler[]>>(
  INTERNAL_HOOK_HANDLERS_KEY,
  () => new Map<string, InternalHookHandler[]>(),
);
const INTERNAL_HOOKS_ENABLED_KEY = Symbol.for("openclaw.internalHooksEnabled");
const internalHooksEnabledState = resolveGlobalSingleton<{ enabled: boolean }>(
  INTERNAL_HOOKS_ENABLED_KEY,
  () => ({ enabled: true }),
);
const log = createSubsystemLogger("internal-hooks");

function listActiveRegistrations() {
  return getActivePluginRegistry()?.legacyInternalHooks ?? [];
}

function listLegacyPluginInternalHooks(event: string): InternalHookHandler[] {
  return listActiveRegistrations()
    .filter((registration) => registration.event === event)
    .map((registration) => registration.handler);
}

function clearLegacyPluginInternalHooks(): void {
  const context = getPluginRegistrationContext();
  (context?.registry ?? requireActivePluginRegistry()).legacyInternalHooks.length = 0;
}

/** Register for a family (e.g. "command") or an exact action (e.g. "command:new"). */
export function registerInternalHook(eventKey: string, handler: InternalHookHandler): void {
  if (!handlers.has(eventKey)) {
    handlers.set(eventKey, []);
  }
  handlers.get(eventKey)!.push(handler);
}

export function unregisterInternalHook(eventKey: string, handler: InternalHookHandler): void {
  const eventHandlers = handlers.get(eventKey);
  if (!eventHandlers) {
    return;
  }

  const index = eventHandlers.indexOf(handler);
  if (index !== -1) {
    eventHandlers.splice(index, 1);
  }

  if (eventHandlers.length === 0) {
    handlers.delete(eventKey);
  }
}

export function clearInternalHooks(): void {
  handlers.clear();
  clearLegacyPluginInternalHooks();
}

export function setInternalHooksEnabled(enabled: boolean): void {
  internalHooksEnabledState.enabled = enabled;
}

export function hasInternalHookListeners(type: InternalHookEventType, action: string): boolean {
  return (
    (handlers.get(type)?.length ?? 0) + listLegacyPluginInternalHooks(type).length > 0 ||
    (handlers.get(`${type}:${action}`)?.length ?? 0) +
      listLegacyPluginInternalHooks(`${type}:${action}`).length >
      0
  );
}

/** Dispatch family handlers before exact-action handlers, in registration order; isolate errors. */
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  if (!internalHooksEnabledState.enabled) {
    return;
  }
  // An admitted event finishes its snapshot even if a handler awaits across a reload or disable.
  const specificKey = `${event.type}:${event.action}`;
  const allHandlers = [
    ...(handlers.get(event.type) ?? []),
    ...listLegacyPluginInternalHooks(event.type),
    ...(handlers.get(specificKey) ?? []),
    ...listLegacyPluginInternalHooks(specificKey),
  ];

  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      const message = formatErrorMessage(err);
      log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
    }
  }
}

export function createInternalHookEvent(
  type: InternalHookEventType,
  action: string,
  sessionKey: string,
  context: Record<string, unknown> = {},
): InternalHookEvent {
  return {
    type,
    action,
    sessionKey,
    context:
      "sessionEntry" in context || "previousSessionEntry" in context
        ? omitHookContextOperatorSources(context)
        : context,
    timestamp: new Date(),
    messages: [],
  };
}

/** Hook listeners receive session entries, never their recorded authentication sources. */
export function omitHookSessionOperatorSources<T>(entry: T): T {
  if (!isRecord(entry) || !Object.hasOwn(entry, "operatorSources")) {
    return entry;
  }
  const { operatorSources: _private, ...rest } = entry;
  // SAFETY: removing one private key keeps every other field of the caller's entry shape.
  return rest as T;
}

function omitHookContextOperatorSources(context: Record<string, unknown>): Record<string, unknown> {
  const next = { ...context };
  for (const key of ["sessionEntry", "previousSessionEntry"]) {
    if (key in next) {
      next[key] = omitHookSessionOperatorSources(next[key]);
    }
  }
  return next;
}

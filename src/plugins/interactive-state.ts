import { createDedupeCache, resolveGlobalDedupeCache } from "../infra/dedupe.js";
import type { DedupeCache } from "../infra/dedupe.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";

export type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

type InteractiveState = {
  interactiveHandlers: Map<string, RegisteredInteractiveHandler>;
  callbackDedupe: ReturnType<typeof createDedupeCache>;
  inflightCallbackDedupe: Set<string>;
};

const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");
const PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY = Symbol.for(
  "openclaw.pluginInteractiveCallbackDedupe",
);

function createInteractiveCallbackDedupe(): DedupeCache {
  return resolveGlobalDedupeCache(PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY, {
    ttlMs: 5 * 60_000,
    maxSize: 4096,
  });
}

function createInteractiveState(): InteractiveState {
  return {
    interactiveHandlers: new Map<string, RegisteredInteractiveHandler>(),
    callbackDedupe: createInteractiveCallbackDedupe(),
    inflightCallbackDedupe: new Set<string>(),
  };
}

/**
 * Rehydrate older global state shapes after duplicate module loads or tests
 * that intentionally seed partial state.
 */
function hydrateInteractiveState(value: unknown): InteractiveState {
  const state =
    typeof value === "object" && value !== null
      ? (value as Partial<InteractiveState>)
      : ({} as Partial<InteractiveState>);

  return {
    interactiveHandlers:
      state.interactiveHandlers instanceof Map
        ? state.interactiveHandlers
        : new Map<string, RegisteredInteractiveHandler>(),
    callbackDedupe: createInteractiveCallbackDedupe(),
    inflightCallbackDedupe:
      state.inflightCallbackDedupe instanceof Set
        ? state.inflightCallbackDedupe
        : new Set<string>(),
  };
}

function getState() {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[PLUGIN_INTERACTIVE_STATE_KEY];
  if (existing !== undefined) {
    const hydrated = hydrateInteractiveState(existing);
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = hydrated;
    return hydrated;
  }

  const created = createInteractiveState();
  globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = created;
  return created;
}

/**
 * Return the process-wide handler registry shared by plugin loader instances.
 */
export function getPluginInteractiveHandlersState() {
  return getState().interactiveHandlers;
}

function getPluginInteractiveCallbackDedupeState() {
  return getState().callbackDedupe;
}

export function claimPluginInteractiveCallbackDedupe(
  dedupeKey: string | undefined,
  now = Date.now(),
): boolean {
  if (!dedupeKey) {
    return true;
  }
  const state = getState();
  // Track in-flight ids separately from the TTL cache so concurrent deliveries
  // cannot both run before the first handler commits the completed callback id.
  if (state.inflightCallbackDedupe.has(dedupeKey) || state.callbackDedupe.peek(dedupeKey, now)) {
    return false;
  }
  state.inflightCallbackDedupe.add(dedupeKey);
  return true;
}

/**
 * Mark an interactive callback id as completed and duplicate-suppressed.
 */
export function commitPluginInteractiveCallbackDedupe(
  dedupeKey: string | undefined,
  now = Date.now(),
): void {
  if (!dedupeKey) {
    return;
  }
  const state = getState();
  state.inflightCallbackDedupe.delete(dedupeKey);
  state.callbackDedupe.check(dedupeKey, now);
}

/**
 * Release an in-flight callback id after a handler failure so retry can proceed.
 */
export function releasePluginInteractiveCallbackDedupe(dedupeKey: string | undefined): void {
  if (!dedupeKey) {
    return;
  }
  getState().inflightCallbackDedupe.delete(dedupeKey);
}

/**
 * Clear handlers and dedupe state for tests or full plugin registry resets.
 */
export function clearPluginInteractiveHandlersState(): void {
  clearPluginInteractiveHandlerRegistrationsState();
  getPluginInteractiveCallbackDedupeState().clear();
  getState().inflightCallbackDedupe.clear();
}

/**
 * Clear registered handlers while preserving callback dedupe history.
 */
export function clearPluginInteractiveHandlerRegistrationsState(): void {
  getPluginInteractiveHandlersState().clear();
}

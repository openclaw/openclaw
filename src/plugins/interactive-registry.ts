import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizePluginInteractiveNamespace,
  resolvePluginInteractiveMatch,
  toPluginInteractiveRegistryKey,
  validatePluginInteractiveNamespace,
} from "./interactive-shared.js";
import {
  clearPluginInteractiveHandlerRegistrationsState,
  clearPluginInteractiveHandlersState,
  getPluginInteractiveHandlersState,
  type RegisteredInteractiveHandler,
} from "./interactive-state.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";

/** Result returned when a plugin registers an interactive callback namespace. */
export type InteractiveRegistrationResult = {
  ok: boolean;
  error?: string;
};

/** Resolves a channel/data pair to a registered interactive handler and decoded payload. */
export function resolvePluginInteractiveNamespaceMatch(
  channel: string,
  data: string,
): { registration: RegisteredInteractiveHandler; namespace: string; payload: string } | null {
  return resolvePluginInteractiveMatch({
    interactiveHandlers: getPluginInteractiveHandlersState(),
    channel,
    data,
  });
}

/** Registers one plugin-owned interactive namespace for a channel. */
export function registerPluginInteractiveHandler(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  const interactiveHandlers = getPluginInteractiveHandlersState();
  const namespace = normalizePluginInteractiveNamespace(registration.namespace);
  const validationError = validatePluginInteractiveNamespace(namespace);
  if (validationError) {
    return { ok: false, error: validationError };
  }
  const key = toPluginInteractiveRegistryKey(registration.channel, namespace);
  const existing = interactiveHandlers.get(key);
  if (existing) {
    return {
      ok: false,
      error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`,
    };
  }
  // Registry keys are channel + normalized namespace, so different plugins cannot silently
  // claim the same callback prefix for the same transport.
  interactiveHandlers.set(key, {
    ...registration,
    namespace,
    channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
  });
  return { ok: true };
}

/** Clears active interactive handlers and registration bookkeeping. */
export function clearPluginInteractiveHandlers(): void {
  clearPluginInteractiveHandlersState();
}

/** Clears registration bookkeeping while leaving active handler state untouched. */
export function clearPluginInteractiveHandlerRegistrations(): void {
  clearPluginInteractiveHandlerRegistrationsState();
}

/** Removes all interactive handlers owned by one plugin. */
export function clearPluginInteractiveHandlersForPlugin(pluginId: string): void {
  const interactiveHandlers = getPluginInteractiveHandlersState();
  for (const [key, value] of interactiveHandlers.entries()) {
    if (value.pluginId === pluginId) {
      interactiveHandlers.delete(key);
    }
  }
}

/** Lists the current interactive handler registrations for loader snapshotting. */
export function listPluginInteractiveHandlers(): RegisteredInteractiveHandler[] {
  return Array.from(getPluginInteractiveHandlersState().values());
}

/** Restores interactive handlers from a loader snapshot, skipping invalid empty namespaces. */
export function restorePluginInteractiveHandlers(
  registrations: readonly RegisteredInteractiveHandler[],
): void {
  clearPluginInteractiveHandlerRegistrations();
  const interactiveHandlers = getPluginInteractiveHandlersState();
  for (const registration of registrations) {
    const namespace = normalizePluginInteractiveNamespace(registration.namespace);
    if (!namespace) {
      continue;
    }
    interactiveHandlers.set(toPluginInteractiveRegistryKey(registration.channel, namespace), {
      ...registration,
      namespace,
      channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
    });
  }
}

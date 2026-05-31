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

export type InteractiveRegistrationResult = {
  ok: boolean;
  error?: string;
};

/** Resolves a channel payload to the registered plugin interactive handler and stripped payload. */
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

/** Registers one plugin interactive namespace for a channel, rejecting duplicate ownership. */
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
  interactiveHandlers.set(key, {
    ...registration,
    namespace,
    // Store normalized channels so restore/list/match use the same registry key shape.
    channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
  });
  return { ok: true };
}

export function clearPluginInteractiveHandlers(): void {
  clearPluginInteractiveHandlersState();
}

export function clearPluginInteractiveHandlerRegistrations(): void {
  clearPluginInteractiveHandlerRegistrationsState();
}

export function clearPluginInteractiveHandlersForPlugin(pluginId: string): void {
  const interactiveHandlers = getPluginInteractiveHandlersState();
  for (const [key, value] of interactiveHandlers.entries()) {
    if (value.pluginId === pluginId) {
      interactiveHandlers.delete(key);
    }
  }
}

/** Returns a snapshot of registered interactive handlers for diagnostics or restoration. */
export function listPluginInteractiveHandlers(): RegisteredInteractiveHandler[] {
  return Array.from(getPluginInteractiveHandlersState().values());
}

/** Replaces registrations from a trusted snapshot, skipping entries with invalid namespaces. */
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

import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { clearPluginInteractiveHandlersState } from "./interactive-state.js";
import { wrapCurrentPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  getPluginRegistrationContext,
  requireActivePluginChannelRegistry,
  resolveDirectPluginRegistrationOwner,
} from "./runtime.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";

/** Registered interactive handler with owning plugin metadata. */
export type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

/** Registration result for plugin interactive namespace handlers. */
type InteractiveRegistrationResult = {
  ok: boolean;
  error?: string;
};

function toPluginInteractiveRegistryKey(channel: string, namespace: string): string {
  return `${normalizeOptionalLowercaseString(channel) ?? ""}:${namespace.trim()}`;
}

/** Resolves a handler from registry-owned registrations without changing global state. */
export function resolvePluginInteractiveRegistrationsMatch(
  registrations: readonly RegisteredInteractiveHandler[],
  channel: string,
  data: string,
): { registration: RegisteredInteractiveHandler; namespace: string; payload: string } | null {
  const trimmedData = data.trim();
  if (!trimmedData) {
    return null;
  }
  const separatorIndex = trimmedData.indexOf(":");
  const namespace = separatorIndex >= 0 ? trimmedData.slice(0, separatorIndex) : trimmedData;
  const key = toPluginInteractiveRegistryKey(channel, namespace);
  const registration = registrations.find(
    (entry) => toPluginInteractiveRegistryKey(entry.channel, entry.namespace) === key,
  );
  return registration
    ? {
        registration,
        namespace,
        payload: separatorIndex >= 0 ? trimmedData.slice(separatorIndex + 1) : "",
      }
    : null;
}

/** Registers one handler whose lifetime follows its owning plugin registry. */
export function registerPluginInteractiveHandlerInRegistry(
  registry: PluginRegistry,
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  const registrations = registry.interactiveHandlers;
  const namespace = registration.namespace.trim();
  if (!namespace) {
    return { ok: false, error: "Interactive handler namespace cannot be empty" };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(namespace)) {
    return {
      ok: false,
      error:
        "Interactive handler namespace must contain only letters, numbers, dots, underscores, and hyphens",
    };
  }
  const key = toPluginInteractiveRegistryKey(registration.channel, namespace);
  const existing = registrations.find(
    (entry) => toPluginInteractiveRegistryKey(entry.channel, entry.namespace) === key,
  );
  if (existing) {
    return {
      ok: false,
      error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`,
    };
  }
  registrations.push({
    ...wrapCurrentPluginInstance(registration),
    namespace,
    channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
  });
  return { ok: true };
}

/** Registers one process-global interactive handler. */
export function registerPluginInteractiveHandler(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  return registerPluginInteractiveHandlerInRegistry(
    getPluginRegistrationContext()?.registry ?? requireActivePluginChannelRegistry(),
    resolveDirectPluginRegistrationOwner(pluginId) ?? pluginId,
    registration,
    opts,
  );
}

/** Clears all active plugin interactive handlers. */
export function clearPluginInteractiveHandlers(): void {
  requireActivePluginChannelRegistry().interactiveHandlers.length = 0;
  clearPluginInteractiveHandlersState();
}

import { registerPluginCommand } from "../plugins/commands.js";
import { normalizeRegisteredProvider } from "../plugins/provider-validation.js";
import type { PluginRecord, PluginRegistry } from "../plugins/registry.js";
import type {
  OpenClawPluginCommandDefinition,
  PluginDiagnostic,
  ProviderPlugin,
} from "../plugins/types.js";
import {
  type ExtensionHostCommandRegistration,
  type ExtensionHostProviderRegistration,
  resolveExtensionCommandRegistration,
  resolveExtensionProviderRegistration,
} from "./runtime-registrations.js";
import { listExtensionHostProviderRegistrations } from "./runtime-registry.js";

export function pushExtensionHostRegistryDiagnostic(params: {
  registry: PluginRegistry;
  level: PluginDiagnostic["level"];
  pluginId: string;
  source: string;
  message: string;
}) {
  params.registry.diagnostics.push({
    level: params.level,
    pluginId: params.pluginId,
    source: params.source,
    message: params.message,
  });
}

export function resolveExtensionHostProviderCompatibility(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  provider: ProviderPlugin;
}):
  | {
      ok: true;
      providerId: string;
      entry: ExtensionHostProviderRegistration;
    }
  | { ok: false } {
  const pushDiagnostic = (diag: PluginDiagnostic) => {
    params.registry.diagnostics.push(diag);
  };

  const normalizedProvider = normalizeRegisteredProvider({
    pluginId: params.record.id,
    source: params.record.source,
    provider: params.provider,
    pushDiagnostic,
  });
  if (!normalizedProvider) {
    return { ok: false };
  }

  const result = resolveExtensionProviderRegistration({
    existing: [...listExtensionHostProviderRegistrations(params.registry)],
    ownerPluginId: params.record.id,
    ownerSource: params.record.source,
    provider: normalizedProvider,
  });
  if (!result.ok) {
    pushExtensionHostRegistryDiagnostic({
      registry: params.registry,
      level: "error",
      pluginId: params.record.id,
      source: params.record.source,
      message: result.message,
    });
    return { ok: false };
  }

  return result;
}

export function resolveExtensionHostCommandCompatibility(params: {
  registry: PluginRegistry;
  record: PluginRecord;
  command: OpenClawPluginCommandDefinition;
}):
  | {
      ok: true;
      commandName: string;
      entry: ExtensionHostCommandRegistration;
    }
  | { ok: false } {
  const normalized = resolveExtensionCommandRegistration({
    ownerPluginId: params.record.id,
    ownerSource: params.record.source,
    command: params.command,
  });
  if (!normalized.ok) {
    pushExtensionHostRegistryDiagnostic({
      registry: params.registry,
      level: "error",
      pluginId: params.record.id,
      source: params.record.source,
      message: normalized.message,
    });
    return { ok: false };
  }

  const result = registerPluginCommand(params.record.id, normalized.entry.command);
  if (!result.ok) {
    pushExtensionHostRegistryDiagnostic({
      registry: params.registry,
      level: "error",
      pluginId: params.record.id,
      source: params.record.source,
      message: `command registration failed: ${result.error}`,
    });
    return { ok: false };
  }

  return normalized;
}

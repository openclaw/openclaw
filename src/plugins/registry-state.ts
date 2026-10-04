import type { UnifiedModelCatalogSource } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import type { PluginDiagnostic } from "./manifest-types.js";
import { createNativeSessionCatalogGate } from "./native-session-catalog-registration.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRecord, PluginRegistryParams } from "./registry-types.js";
import type { PluginHookName, UnifiedModelCatalogProviderPlugin } from "./types.js";

type UnifiedModelCatalogHook = NonNullable<UnifiedModelCatalogProviderPlugin["staticCatalog"]>;

function mergeModelCatalogHooks(
  source: UnifiedModelCatalogSource,
  left: UnifiedModelCatalogHook | undefined,
  right: UnifiedModelCatalogHook | undefined,
): UnifiedModelCatalogHook | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return async (ctx) => {
    const [leftRows, rightRows] = await Promise.all([left(ctx), right(ctx)]);
    const rows = [...(leftRows ?? []), ...(rightRows ?? [])].map((row) => ({ ...row, source }));
    return rows.length ? rows : null;
  };
}

export type PluginTypedHookPolicy = {
  allowPromptInjection?: boolean;
  allowConversationAccess?: boolean;
  timeoutMs?: number;
  timeouts?: Record<string, number>;
};

type PluginRegistrationCapabilities = {
  /** Broad registry writes that discovery and live activation both need. */
  capabilityHandlers: boolean;
  /** Setup-runtime may publish pre-listen gateway surfaces without full activation. */
  setupRuntimeHandlers: boolean;
  /** Runtime channel registration is suppressed for setup-only and tool discovery loads. */
  runtimeChannel: boolean;
};

/** Decode the public mode once so domain registrars do not repeat string checks. */
export function resolvePluginRegistrationCapabilities(
  mode: import("./types.js").PluginRegistrationMode,
): PluginRegistrationCapabilities {
  const capabilityHandlers = mode === "full" || mode === "discovery" || mode === "tool-discovery";
  return {
    capabilityHandlers,
    setupRuntimeHandlers: mode === "setup-runtime",
    runtimeChannel: mode !== "setup-only" && mode !== "tool-discovery",
  };
}

function normalizeHookTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function resolveTypedHookTimeoutMs(params: {
  hookName: PluginHookName;
  opts?: { timeoutMs?: number };
  policy?: PluginTypedHookPolicy;
}): number | undefined {
  return (
    normalizeHookTimeoutMs(params.policy?.timeouts?.[params.hookName]) ??
    normalizeHookTimeoutMs(params.policy?.timeoutMs) ??
    normalizeHookTimeoutMs(params.opts?.timeoutMs)
  );
}

function createRegistration<T extends object>(
  record: PluginRecord,
  contribution: T,
  ownership: "wrap" | "adopt" = "wrap",
) {
  return {
    pluginId: record.id,
    pluginName: record.name,
    // Normalizers and host gates create new callables after API argument wrapping.
    ...(getPluginInstance(record)?.[ownership](contribution) ?? contribution),
    source: record.source,
    rootDir: record.rootDir,
  };
}

export function createPluginRegistryState(registryParams: PluginRegistryParams) {
  const registry = createEmptyPluginRegistry();
  const nativeCatalogGates = new WeakMap<
    PluginRecord,
    ReturnType<typeof createNativeSessionCatalogGate>
  >();
  const getNativeCatalogGate = (record: PluginRecord) => {
    if (!record.nativeSessionCatalog) {
      return undefined;
    }
    let gate = nativeCatalogGates.get(record);
    if (!gate) {
      gate = createNativeSessionCatalogGate({
        pluginId: record.id,
        getConfig: () => registryParams.runtime.config.current(),
      });
      nativeCatalogGates.set(record, gate);
    }
    return gate;
  };
  bindPluginRegistryRuntime(registry, registryParams.runtime);
  const coreGatewayMethods = new Set(registryParams.coreGatewayMethodNames);
  for (const name of Object.keys(registryParams.coreGatewayHandlers ?? {})) {
    coreGatewayMethods.add(name);
  }
  registry.coreGatewayMethodNames = Array.from(coreGatewayMethods);
  registry.coreGatewayMethodNames.sort();

  const pushDiagnostic = (diagnostic: PluginDiagnostic) => {
    registry.diagnostics.push(diagnostic);
  };
  const reportRegistrationError = (record: PluginRecord, message: string) => {
    pushDiagnostic({ level: "error", pluginId: record.id, source: record.source, message });
  };
  const reportRegistrationWarning = (record: PluginRecord, message: string) => {
    pushDiagnostic({ level: "warn", pluginId: record.id, source: record.source, message });
  };
  const registerModelCatalogProvider = (
    record: PluginRecord,
    provider: UnifiedModelCatalogProviderPlugin,
  ) => {
    const providerId = normalizeOptionalString(provider.provider) ?? "";
    if (!providerId) {
      reportRegistrationError(record, "model catalog provider registration missing provider");
      return;
    }
    if (!provider.kinds || provider.kinds.length === 0) {
      reportRegistrationError(
        record,
        `model catalog provider "${providerId}" registration missing kinds`,
      );
      return;
    }
    const existing = registry.modelCatalogProviders.find(
      (entry) => entry.provider.provider === providerId && entry.pluginId !== record.id,
    );
    if (existing) {
      reportRegistrationError(
        record,
        `model catalog provider already registered: ${providerId} (${existing.pluginId})`,
      );
      return;
    }
    const normalizedKinds = uniqueValues(provider.kinds);
    const samePluginOverlapping = registry.modelCatalogProviders.find(
      (entry) =>
        entry.provider.provider === providerId &&
        entry.pluginId === record.id &&
        entry.provider.kinds.some((kind) => normalizedKinds.includes(kind)),
    );
    if (samePluginOverlapping) {
      samePluginOverlapping.provider = {
        ...samePluginOverlapping.provider,
        ...provider,
        provider: providerId,
        kinds: uniqueValues([...samePluginOverlapping.provider.kinds, ...normalizedKinds]),
        staticCatalog: mergeModelCatalogHooks(
          "static",
          samePluginOverlapping.provider.staticCatalog,
          provider.staticCatalog,
        ),
        liveCatalog: mergeModelCatalogHooks(
          "live",
          samePluginOverlapping.provider.liveCatalog,
          provider.liveCatalog,
        ),
      };
      return;
    }
    registry.modelCatalogProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: {
        ...provider,
        provider: providerId,
        kinds: normalizedKinds,
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  return {
    registry,
    registryParams,
    getNativeCatalogGate,
    allowProcessHomeSessionCatalogs: registryParams.allowProcessHomeSessionCatalogs ?? true,
    coreGatewayMethods,
    getHostCronService: () => registryParams.hostServices?.cron,
    pluginsWithChannelRegistrationConflict: new Set<string>(),
    createRegistration,
    createIdentityRegistration: <T extends object>(record: PluginRecord, contribution: T) =>
      createRegistration(record, contribution, "adopt"),
    pushDiagnostic,
    reportRegistrationError,
    reportRegistrationWarning,
    registerModelCatalogProvider,
  };
}

export type PluginRegistryState = ReturnType<typeof createPluginRegistryState>;

import type { PluginDiagnostic } from "./manifest-types.js";
import { createModelCatalogRegistrationHandlers } from "./model-catalog-registration.js";
import { createNativeSessionCatalogGate } from "./native-session-catalog-registration.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRecord, PluginRegistryParams } from "./registry-types.js";
import type { PluginHookName } from "./types.js";

export type PluginTypedHookPolicy = {
  allowPromptInjection?: boolean;
  allowConversationAccess?: boolean;
  timeoutMs?: number;
  timeouts?: Record<string, number>;
  failClosed?: boolean;
};

/**
 * Delivery hooks the fail-closed opt-in covers. Both already return `{ cancel: true }`, so an
 * opted-in failure reuses that documented terminal result instead of a new decision shape.
 */
const FAIL_CLOSED_ELIGIBLE_HOOK_NAMES: ReadonlySet<PluginHookName> = new Set([
  "message_sending",
  "reply_payload_sending",
] satisfies readonly PluginHookName[]);

/** Resolves the operator's per-plugin fail-closed opt-in for one typed hook registration. */
export function resolveTypedHookFailClosed(params: {
  hookName: PluginHookName;
  policy?: PluginTypedHookPolicy;
}): boolean {
  return params.policy?.failClosed === true && FAIL_CLOSED_ELIGIBLE_HOOK_NAMES.has(params.hookName);
}

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

function createRegistration<T extends object>(record: PluginRecord, contribution: T) {
  return {
    pluginId: record.id,
    pluginName: record.name,
    // Normalizers and host gates create new callables after API argument wrapping.
    ...(getPluginInstance(record)?.wrap(contribution) ?? contribution),
    source: record.source,
    rootDir: record.rootDir,
  };
}

function createIdentityRegistration<T extends object>(record: PluginRecord, contribution: T) {
  return {
    pluginId: record.id,
    pluginName: record.name,
    ...(getPluginInstance(record)?.adopt(contribution) ?? contribution),
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
  // oxlint-disable-next-line unicorn/no-array-sort -- This array is separate from the membership index.
  registry.coreGatewayMethodNames = Array.from(coreGatewayMethods).sort();

  const pushDiagnostic = (diagnostic: PluginDiagnostic) => {
    registry.diagnostics.push(diagnostic);
  };
  const reportRegistrationError = (record: PluginRecord, message: string) => {
    pushDiagnostic({ level: "error", pluginId: record.id, source: record.source, message });
  };
  const reportRegistrationWarning = (record: PluginRecord, message: string) => {
    pushDiagnostic({ level: "warn", pluginId: record.id, source: record.source, message });
  };
  const modelCatalogRegistrars = createModelCatalogRegistrationHandlers({
    registry,
    pushDiagnostic,
  });

  return {
    registry,
    registryParams,
    getNativeCatalogGate,
    allowProcessHomeSessionCatalogs: registryParams.allowProcessHomeSessionCatalogs ?? true,
    coreGatewayMethods,
    getHostCronService: () => registryParams.hostServices?.cron,
    pluginsWithChannelRegistrationConflict: new Set<string>(),
    createRegistration,
    createIdentityRegistration,
    pushDiagnostic,
    reportRegistrationError,
    reportRegistrationWarning,
    ...modelCatalogRegistrars,
  };
}

export type PluginRegistryState = ReturnType<typeof createPluginRegistryState>;

/** Builds web-tool secret metadata from config, plugins, and provider contracts. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { sortPluginEntriesForAutoDetect } from "../plugins/plugin-entry-order.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchCredentialResolutionSource,
  WebSearchCredentialResolutionSource,
} from "../plugins/types.js";
import {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web-provider-public-artifacts.explicit.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { secretRefKey } from "./ref-contract.js";
import {
  describeSecretResolutionError,
  isProviderScopedSecretResolutionError,
} from "./resolve-errors.js";
import { resolveSecretRefValues } from "./resolve.js";
import {
  associateSecretResolutionErrorOwners,
  isRetryableSecretDegradationReason,
  type DegradedSecretOwner,
  type SecretOwnerRefState,
} from "./runtime-degraded-state.js";
import {
  classifySecretOwnerDegradationState,
  warnDegradedSecretOwner,
} from "./runtime-owner-assignments.js";
import { hasCredentialBearingObjectValue } from "./runtime-secret-scan.js";
import { pushWarning, type ResolverContext, type SecretDefaults } from "./runtime-shared.js";
import { getActiveSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { runtimeWebSecretOwnerId } from "./runtime-web-secret-owner.js";
import type {
  RuntimeWebProviderSelectionResult,
  RuntimeWebSecretOwner,
  RuntimeWebUnavailableProvider,
  SecretResolutionResult,
} from "./runtime-web-tools-selection.types.js";
import {
  readConfiguredProviderCredential,
  resolveRuntimeWebProviderSelection,
} from "./runtime-web-tools.shared.js";
import type {
  RuntimeWebDiagnostic,
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
  RuntimeWebToolsMetadata,
} from "./runtime-web-tools.types.js";
import { isExpectedResolvedSecretValue } from "./secret-value.js";
import { isRecord } from "./shared.js";

const loadRuntimeWebToolsFallbackProviders = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-fallback.runtime.js"),
  ({ runtimeWebToolsFallbackProviders }) => runtimeWebToolsFallbackProviders,
);
const loadRuntimeWebToolsPublicArtifacts = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-public-artifacts.runtime.js"),
  (mod) => mod,
);
const loadRuntimeWebToolsManifest = createLazyRuntimeSurface(
  () => import("./runtime-web-tools-manifest.runtime.js"),
  (mod) => mod,
);

type FetchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["fetch"];

type SecretResolutionSource =
  | WebSearchCredentialResolutionSource
  | WebFetchCredentialResolutionSource;

type RuntimeWebProviderFailure = Omit<RuntimeWebUnavailableProvider, "contractDigest"> & {
  contractDigest?: string;
};
type RuntimeWebProviderFailureByRefKey = Map<
  string,
  NonNullable<RuntimeWebUnavailableProvider["providerFailure"]>
>;

function createUnavailableWebProviderOwner(params: {
  kind: "search" | "fetch";
  unavailable: Pick<
    RuntimeWebUnavailableProvider,
    "providerId" | "path" | "refKey" | "reason" | "providerFailure"
  >;
  degradationState?: "cold" | "stale";
}): DegradedSecretOwner {
  return {
    ownerKind: "capability",
    ownerId: runtimeWebSecretOwnerId(params.kind, params.unavailable.providerId),
    state: "unavailable",
    degradationState: params.degradationState ?? "cold",
    paths: [params.unavailable.path],
    refKeys: [params.unavailable.refKey],
    reason: params.unavailable.reason,
    ...(params.unavailable.providerFailure
      ? { providerFailures: [params.unavailable.providerFailure] }
      : {}),
  };
}

function attachWebProviderFailures(
  unavailableProviders: RuntimeWebProviderFailure[],
  providerFailuresByRefKey: RuntimeWebProviderFailureByRefKey,
): void {
  for (const unavailable of unavailableProviders) {
    unavailable.providerFailure = providerFailuresByRefKey.get(unavailable.refKey);
  }
}

function collectUnavailableWebProviders(params: {
  kind: "search" | "fetch";
  result: RuntimeWebProviderSelectionResult;
  context: ResolverContext;
  sourceConfig: OpenClawConfig;
  metadata: RuntimeWebSearchMetadata | RuntimeWebFetchMetadata;
  degradedOwners: DegradedSecretOwner[];
  forceColdRefKeys?: ReadonlySet<string>;
}): void {
  for (const unavailable of params.result.unavailableProviders) {
    let degradationState = classifySecretOwnerDegradationState({
      ownerKind: "capability",
      ownerId: runtimeWebSecretOwnerId(params.kind, unavailable.providerId),
      refs: [unavailable.ref],
      config: params.sourceConfig,
      contractDigest: unavailable.contractDigest,
      forceColdRefKeys: params.forceColdRefKeys,
    });
    if (degradationState === "stale") {
      const active = getActiveSecretsRuntimeSnapshotState();
      const activeOwner = active?.secretOwners?.find(
        (entry) =>
          entry.ownerKind === "capability" &&
          entry.ownerId === runtimeWebSecretOwnerId(params.kind, unavailable.providerId),
      );
      const value = activeOwner?.resolvedValues?.find(
        (entry) => entry.refKey === unavailable.refKey,
      )?.value;
      try {
        if (typeof value !== "string" || !unavailable.restoreResolvedValue) {
          throw new Error("last-known-good web credential is unavailable");
        }
        unavailable.restoreResolvedValue(value);
        unavailable.resolvedValue = value;
        const selectedOwner = params.result.secretOwners.find(
          (entry) =>
            entry.providerId === unavailable.providerId && entry.refKey === unavailable.refKey,
        );
        if (selectedOwner) {
          selectedOwner.resolvedValue = value;
        }
        const activeMetadata =
          params.kind === "search" ? active?.webTools.search : active?.webTools.fetch;
        if (!activeMetadata) {
          throw new Error("last-known-good web metadata is unavailable");
        }
        for (const key of Object.keys(params.metadata)) {
          delete (params.metadata as Record<string, unknown>)[key];
        }
        Object.assign(params.metadata, structuredClone(activeMetadata));
      } catch {
        degradationState = "cold";
      }
    }
    const owner = createUnavailableWebProviderOwner({
      kind: params.kind,
      unavailable,
      degradationState,
    });
    params.degradedOwners.push(owner);
    warnDegradedSecretOwner(params.context, owner);
  }
}

function toWebSecretOwnerRefState(
  kind: "search" | "fetch",
  owner: RuntimeWebSecretOwner,
): SecretOwnerRefState {
  return {
    ownerKind: "capability",
    ownerId: runtimeWebSecretOwnerId(kind, owner.providerId),
    refKeys: [owner.refKey],
    contractDigest: owner.contractDigest,
    ...(owner.resolvedValue
      ? { resolvedValues: [{ refKey: owner.refKey, value: owner.resolvedValue }] }
      : {}),
  };
}

function associateWebProviderResolutionError(params: {
  kind: "search" | "fetch";
  config: OpenClawConfig;
  error: unknown;
  unavailableProviders: RuntimeWebProviderFailure[];
  forceColdRefKeys?: ReadonlySet<string>;
}): void {
  const failureByRefKey = new Map(
    params.unavailableProviders.map((unavailable) => [unavailable.refKey, unavailable] as const),
  );
  const owners = params.unavailableProviders.map((unavailable) => {
    const owner = createUnavailableWebProviderOwner({ kind: params.kind, unavailable });
    return {
      ...owner,
      degradationState: classifySecretOwnerDegradationState({
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        refs: [unavailable.ref],
        config: params.config,
        contractDigest: unavailable.contractDigest,
        forceColdRefKeys: params.forceColdRefKeys,
      }),
      failureMatched: true,
      source: "config" as const,
    };
  });
  const ownerIds = new Set(owners.map((owner) => owner.ownerId));
  const activeCoOwners = (getActiveSecretsRuntimeSnapshotState()?.secretOwners ?? []).flatMap(
    (owner) => {
      if (
        owner.ownerKind !== "capability" ||
        ownerIds.has(owner.ownerId) ||
        (!owner.ownerId.startsWith("web-search:") && !owner.ownerId.startsWith("web-fetch:"))
      ) {
        return [];
      }
      const matches = owner.refKeys.flatMap((refKey) => {
        const unavailable = failureByRefKey.get(refKey);
        return unavailable ? [unavailable] : [];
      });
      const firstMatch = matches[0];
      if (!firstMatch) {
        return [];
      }
      return [
        {
          ownerKind: owner.ownerKind,
          ownerId: owner.ownerId,
          state: "unavailable" as const,
          paths: [],
          refKeys: [...owner.refKeys],
          reason: firstMatch.reason,
          degradationState: classifySecretOwnerDegradationState({
            ownerKind: owner.ownerKind,
            ownerId: owner.ownerId,
            refs: matches.map((match) => match.ref),
            config: params.config,
            contractDigest: owner.contractDigest,
            forceColdRefKeys: params.forceColdRefKeys,
          }),
          failureMatched: true,
          source: "config" as const,
          ...(firstMatch.providerFailure ? { providerFailures: [firstMatch.providerFailure] } : {}),
        },
      ];
    },
  );
  associateSecretResolutionErrorOwners(params.error, [...owners, ...activeCoOwners]);
}

function needsRuntimeWebFetchProviderDiscovery(params: {
  fetch: FetchConfig;
  rawProvider: string;
  hasPluginWebFetchConfig: boolean;
  defaults: SecretDefaults | undefined;
}): boolean {
  if (isRecord(params.fetch) && params.fetch.enabled === false) {
    return false;
  }
  if (params.hasPluginWebFetchConfig) {
    return true;
  }
  if (!isRecord(params.fetch)) {
    return false;
  }
  if (params.rawProvider) {
    return true;
  }
  // Limits-only fetch config must stay on the runtime fast path; credential-shaped values are
  // the signal that provider discovery and SecretRef resolution are actually needed.
  return hasCredentialBearingObjectValue(params.fetch, params.defaults);
}

function hasPluginScopedWebToolConfig(
  config: OpenClawConfig,
  key: "webSearch" | "webFetch",
): boolean {
  const entries = config.plugins?.entries;
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
    return Boolean(pluginConfig?.[key]);
  });
}

function inferSingleBundledPluginScopedWebToolConfigOwner(
  config: OpenClawConfig,
  key: "webSearch" | "webFetch",
): string | undefined {
  const entries = config.plugins?.entries;
  if (!entries) {
    return undefined;
  }
  const matches: string[] = [];
  for (const [pluginId, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || entry.enabled === false) {
      continue;
    }
    const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
    if (!isRecord(pluginConfig?.[key])) {
      continue;
    }
    matches.push(pluginId);
    if (matches.length > 1) {
      return undefined;
    }
  }
  return matches[0];
}

type WebProviderContract = "webSearchProviders" | "webFetchProviders";

async function hasCustomWebProviderPluginRisk(params: {
  contract: WebProviderContract;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRecords?: readonly PluginManifestRecord[];
}): Promise<boolean> {
  const installRecords = loadInstalledPluginIndexInstallRecordsSync({ env: params.env });
  if (Object.keys(installRecords).length > 0) {
    return true;
  }

  const plugins = params.config.plugins;
  if (!plugins) {
    return false;
  }
  if (Array.isArray(plugins.load?.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  const { resolveManifestContractPluginIds } = await loadRuntimeWebToolsManifest();
  const bundledPluginIds = new Set<string>(
    resolveManifestContractPluginIds({
      contract: params.contract,
      origin: "bundled",
      config: params.config,
      env: params.env,
      manifestRecords: params.manifestRecords,
    }),
  );
  // Public artifacts are complete only for bundled providers. Any configured non-bundled
  // plugin surface has to fall back to manifest/runtime discovery to avoid hiding providers.
  const hasNonBundledPluginId = (pluginId: string) => !bundledPluginIds.has(pluginId.trim());
  if (Array.isArray(plugins.allow) && plugins.allow.some(hasNonBundledPluginId)) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.some(hasNonBundledPluginId)) {
    return true;
  }
  return Boolean(plugins.entries && Object.keys(plugins.entries).some(hasNonBundledPluginId));
}

function readNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  names: string[],
): { value?: string; envVar?: string } {
  for (const envVar of names) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return { value, envVar };
    }
  }
  return {};
}

async function resolveSecretInputWithEnvFallback(params: {
  kind: "search" | "fetch";
  providerId: string;
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  defaults: SecretDefaults | undefined;
  value: unknown;
  path: string;
  envVars: string[];
  contractDigest: string;
  providerFailuresByRefKey: RuntimeWebProviderFailureByRefKey;
  forceColdRefKeys?: ReadonlySet<string>;
}): Promise<SecretResolutionResult<SecretResolutionSource>> {
  // Provider credential callbacks retain their shipped unknown-valued input contract.
  const ref = coerceSecretRef(params.value, params.defaults);

  if (!ref) {
    const configValue = normalizeSecretInput(params.value);
    if (configValue) {
      return {
        value: configValue,
        source: "config",
        secretRefConfigured: false,
      };
    }
    const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
    if (fallback.value) {
      return {
        value: fallback.value,
        source: "env",
        fallbackEnvVar: fallback.envVar,
        secretRefConfigured: false,
      };
    }
    return {
      source: "missing",
      secretRefConfigured: false,
    };
  }

  const associateFailure = (error: unknown, reason: RuntimeWebProviderFailure["reason"]) => {
    associateWebProviderResolutionError({
      kind: params.kind,
      config: params.sourceConfig,
      error,
      forceColdRefKeys: params.forceColdRefKeys,
      unavailableProviders: [
        {
          providerId: params.providerId,
          path: params.path,
          ref,
          refKey: secretRefKey(ref),
          reason,
          contractDigest: params.contractDigest,
        },
      ],
    });
  };

  let resolvedFromRef: string | undefined;
  let unresolvedRefReason: SecretResolutionResult<SecretResolutionSource>["unresolvedRefReason"];

  if (params.kind === "fetch" && ref.source === "env" && !params.envVars.includes(ref.id)) {
    throw new Error(`${params.path} SecretRef is not allowed for this provider.`);
  } else {
    try {
      const resolved = await resolveSecretRefValues([ref], {
        config: params.sourceConfig,
        env: params.context.env,
        cache: params.context.cache,
        manifestRegistry: params.context.manifestRegistry,
      });
      const resolvedValue = resolved.get(secretRefKey(ref));
      if (!isExpectedResolvedSecretValue(resolvedValue, "string")) {
        const error = new Error(`${params.path} resolved to a non-string or empty value.`);
        associateFailure(error, "resolved secret value was invalid");
        throw error;
      }
      resolvedFromRef = normalizeSecretInput(resolvedValue);
    } catch (error) {
      const reason = describeSecretResolutionError(error);
      if (!reason || !isRetryableSecretDegradationReason(reason)) {
        // Invalid provider config or resolved values are structural failures. They must fail
        // activation before publishing an owner degradation that could imply retryability.
        if (reason) {
          associateFailure(error, reason);
        }
        throw error;
      }
      unresolvedRefReason = reason;
      if (isProviderScopedSecretResolutionError(error)) {
        params.providerFailuresByRefKey.set(secretRefKey(ref), {
          source: error.source,
          provider: error.provider,
        });
      }
    }
  }

  return {
    ...(resolvedFromRef
      ? { value: resolvedFromRef, source: "secretRef" as const }
      : { source: "missing" as const, unresolvedRefReason }),
    secretRef: ref,
    secretRefKey: secretRefKey(ref),
    secretRefConfigured: true,
  };
}

async function resolveBundledWebProviders(params: {
  kind: "search" | "fetch";
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  configuredBundledPluginId?: string;
  hasCustomPluginRisk: boolean;
}): Promise<Array<PluginWebSearchProviderEntry | PluginWebFetchProviderEntry>> {
  const env = { ...process.env, ...params.context.env };
  const onlyPluginIds =
    params.configuredBundledPluginId !== undefined &&
    (params.kind === "search" || params.configuredBundledPluginId)
      ? [params.configuredBundledPluginId]
      : undefined;
  const origin = onlyPluginIds || !params.hasCustomPluginRisk ? "bundled" : undefined;
  // Explicit bundled hints avoid loading every provider manifest. Custom-plugin risk
  // still uses runtime discovery so installed or path-loaded providers participate.
  if (onlyPluginIds) {
    const resolve =
      params.kind === "search"
        ? resolveBundledExplicitWebSearchProvidersFromPublicArtifacts
        : resolveBundledExplicitWebFetchProvidersFromPublicArtifacts;
    const bundled = resolve({
      onlyPluginIds,
      env,
      manifestRecords: params.context.manifestRegistry?.plugins,
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
  } else if (!params.hasCustomPluginRisk) {
    const artifacts = await loadRuntimeWebToolsPublicArtifacts();
    const resolve =
      params.kind === "search"
        ? artifacts.resolveBundledWebSearchProvidersFromPublicArtifacts
        : artifacts.resolveBundledWebFetchProvidersFromPublicArtifacts;
    const bundled = resolve({
      config: params.sourceConfig,
      env,
      manifestRecords: params.context.manifestRegistry?.plugins,
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
  }
  const providers = await loadRuntimeWebToolsFallbackProviders();
  const resolve =
    params.kind === "search"
      ? providers.resolvePluginWebSearchProviders
      : providers.resolvePluginWebFetchProviders;
  return resolve({
    config: params.sourceConfig,
    env,
    ...(onlyPluginIds ? { onlyPluginIds } : {}),
    // Fetch credential resolution admits only bundled or verified official providers.
    ...(origin ? { origin } : params.kind === "fetch" ? { sandboxed: true } : {}),
    manifestRecords: params.context.manifestRegistry?.plugins,
  });
}

/**
 * Resolves runtime web search/fetch provider metadata and writes selected credentials into a
 * cloned runtime config without mutating the source config.
 */
export async function resolveRuntimeWebTools(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  context: ResolverContext;
  allowUnavailableSecretOwners?: boolean;
  forceColdRefKeys?: ReadonlySet<string>;
}) {
  const defaults = params.sourceConfig.secrets?.defaults;
  const diagnostics: RuntimeWebDiagnostic[] = [];
  const degradedOwners: DegradedSecretOwner[] = [];
  const secretOwners: SecretOwnerRefState[] = [];
  const providerFailuresByRefKey: RuntimeWebProviderFailureByRefKey = new Map();
  const env = { ...process.env, ...params.context.env };

  const sourceTools = isRecord(params.sourceConfig.tools) ? params.sourceConfig.tools : undefined;
  const sourceWeb = isRecord(sourceTools?.web) ? sourceTools.web : undefined;
  const customWebProviderRisks: Partial<Record<WebProviderContract, Promise<boolean>>> = {};
  const getHasCustomWebProviderRisk = (contract: WebProviderContract): Promise<boolean> => {
    customWebProviderRisks[contract] ??= hasCustomWebProviderPluginRisk({
      contract,
      config: params.sourceConfig,
      env,
      manifestRecords: params.context.manifestRegistry?.plugins,
    });
    return customWebProviderRisks[contract];
  };
  const hasPluginWebSearchConfig = hasPluginScopedWebToolConfig(params.sourceConfig, "webSearch");
  const hasPluginWebFetchConfig = hasPluginScopedWebToolConfig(params.sourceConfig, "webFetch");
  const search = isRecord(sourceWeb?.search) ? sourceWeb.search : undefined;
  const fetch = isRecord(sourceWeb?.fetch) ? (sourceWeb.fetch as FetchConfig) : undefined;
  const webTools: RuntimeWebToolsMetadata = {
    search: { providerSource: "none", diagnostics: [] },
    fetch: { providerSource: "none", diagnostics: [] },
    diagnostics,
  };
  const result = { metadata: webTools, degradedOwners, secretOwners };
  if (!search && !fetch && !hasPluginWebSearchConfig && !hasPluginWebFetchConfig) {
    return result;
  }
  for (const kind of ["search", "fetch"] as const) {
    const toolConfig = kind === "search" ? search : fetch;
    const rawProvider = normalizeLowercaseStringOrEmpty(toolConfig?.provider);
    const contract = kind === "search" ? "webSearchProviders" : "webFetchProviders";
    let configuredBundledPluginIdHint: string | undefined;
    if (
      kind === "search" &&
      hasPluginWebSearchConfig &&
      !(await getHasCustomWebProviderRisk(contract))
    ) {
      if (rawProvider) {
        const entry = params.sourceConfig.plugins?.entries?.[rawProvider];
        if (isRecord(entry) && entry.enabled !== false) {
          const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
          if (isRecord(pluginConfig?.webSearch)) {
            configuredBundledPluginIdHint = rawProvider;
          }
        }
      }
      configuredBundledPluginIdHint ??= inferSingleBundledPluginScopedWebToolConfigOwner(
        params.sourceConfig,
        "webSearch",
      );
    }
    const discoverProviders =
      kind === "search"
        ? search || hasPluginWebSearchConfig
        : needsRuntimeWebFetchProviderDiscovery({
            fetch,
            rawProvider,
            hasPluginWebFetchConfig,
            defaults,
          });
    if (!discoverProviders) {
      continue;
    }
    const metadata = webTools[kind];
    const isSearch = kind === "search";
    let configuredBundledPluginId = configuredBundledPluginIdHint;
    const resolveManifestOwner = async () => {
      const { resolveManifestContractOwnerPluginId } = await loadRuntimeWebToolsManifest();
      return resolveManifestContractOwnerPluginId({
        contract,
        value: rawProvider,
        origin: "bundled",
        config: params.sourceConfig,
        env: { ...process.env, ...params.context.env },
        manifestRecords: params.context.manifestRegistry?.plugins,
      });
    };
    const resolveProviders = async () =>
      sortPluginEntriesForAutoDetect(
        await resolveBundledWebProviders({
          kind,
          sourceConfig: params.sourceConfig,
          context: params.context,
          configuredBundledPluginId,
          hasCustomPluginRisk: await getHasCustomWebProviderRisk(contract),
        }),
      );
    if (!configuredBundledPluginId && rawProvider) {
      configuredBundledPluginId = await resolveManifestOwner();
    }
    let allProviders = await resolveProviders();
    if (
      rawProvider &&
      configuredBundledPluginIdHint &&
      configuredBundledPluginId &&
      !allProviders.some((provider) => provider.id === rawProvider)
    ) {
      configuredBundledPluginId = undefined;
    }
    if (
      rawProvider &&
      !configuredBundledPluginId &&
      !allProviders.some((provider) => provider.id === rawProvider)
    ) {
      configuredBundledPluginId = await resolveManifestOwner();
      allProviders = await resolveProviders();
    }
    const hasConfiguredSurface =
      Boolean(toolConfig) ||
      allProviders.some(
        (provider) =>
          !(isSearch && provider.requiresCredential === false) &&
          (readConfiguredProviderCredential({
            provider,
            config: params.sourceConfig,
            toolConfig,
          }) !== undefined ||
            provider.getConfiguredCredentialFallback?.(params.sourceConfig)?.value !== undefined),
      );
    const providers = hasConfiguredSurface || !isSearch ? allProviders : [];
    const configuredProvider =
      rawProvider &&
      (isSearch ? providers : allProviders).some((provider) => provider.id === rawProvider)
        ? rawProvider
        : undefined;
    const invalidConfiguredProvider = isSearch && Boolean(rawProvider) && !configuredProvider;
    if (rawProvider && !configuredProvider) {
      const diagnostic = {
        code: isSearch
          ? "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT"
          : "WEB_FETCH_PROVIDER_INVALID_AUTODETECT",
        message: invalidConfiguredProvider
          ? `tools.web.${kind}.provider is "${rawProvider}". No provider will be selected.`
          : `tools.web.${kind}.provider is "${rawProvider}". Falling back to auto-detect precedence.`,
        path: `tools.web.${kind}.provider`,
      } satisfies RuntimeWebDiagnostic;
      diagnostics.push(diagnostic);
      metadata.diagnostics.push(diagnostic);
      pushWarning(params.context, {
        code: diagnostic.code,
        path: diagnostic.path,
        message: diagnostic.message,
      });
    }

    const selection = await resolveRuntimeWebProviderSelection({
      kind,
      toolConfig,
      enabled: hasConfiguredSurface && !invalidConfiguredProvider && toolConfig?.enabled !== false,
      providers,
      configuredProvider,
      metadata,
      diagnostics,
      sourceConfig: params.sourceConfig,
      resolvedConfig: params.resolvedConfig,
      context: params.context,
      defaults,
      allowUnavailableProviders: params.allowUnavailableSecretOwners,
      onUnavailableProviders: (error) => {
        attachWebProviderFailures(error.unavailableProviders, providerFailuresByRefKey);
        associateWebProviderResolutionError({
          kind,
          config: params.sourceConfig,
          error,
          forceColdRefKeys: params.forceColdRefKeys,
          unavailableProviders: error.unavailableProviders,
        });
      },
      resolveSecretInput: (input) =>
        resolveSecretInputWithEnvFallback({
          ...input,
          kind,
          sourceConfig: params.sourceConfig,
          context: params.context,
          defaults,
          providerFailuresByRefKey,
          forceColdRefKeys: params.forceColdRefKeys,
        }),
    });
    attachWebProviderFailures(selection.unavailableProviders, providerFailuresByRefKey);
    collectUnavailableWebProviders({
      kind,
      result: selection,
      context: params.context,
      sourceConfig: params.sourceConfig,
      metadata,
      degradedOwners,
      forceColdRefKeys: params.forceColdRefKeys,
    });
    for (const owner of selection.secretOwners) {
      secretOwners.push(toWebSecretOwnerRefState(kind, owner));
    }
  }

  return result;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

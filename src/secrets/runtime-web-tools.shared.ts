import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebSearchCredentialResolutionSource,
} from "../plugins/types.js";
import { setPathExistingStrict } from "./path-utils.js";
import type { SecretDegradationReason } from "./runtime-degraded-state.js";
import { digestRuntimeWebOwnerContract } from "./runtime-owner-contract.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import { pushInactiveSurfaceWarning, pushWarning } from "./runtime-shared.js";
import {
  RuntimeWebProviderUnavailableError,
  type RuntimeWebResolveSecretInputParams,
  type RuntimeWebProviderSelectionResult,
  type RuntimeWebUnavailableProvider,
  type SecretResolutionResult,
} from "./runtime-web-tools-selection.types.js";
import type { RuntimeWebDiagnostic, RuntimeWebSearchMetadata } from "./runtime-web-tools.types.js";
import { isRecord, parseDotPath } from "./shared.js";

type RuntimeWebProvider = PluginWebSearchProviderEntry | PluginWebFetchProviderEntry;

export function readConfiguredProviderCredential(params: {
  provider: RuntimeWebProvider;
  config: OpenClawConfig;
  toolConfig: Record<string, unknown> | undefined;
}): unknown {
  return (
    params.provider.getConfiguredCredentialValue?.(params.config) ??
    params.provider.getCredentialValue(params.toolConfig)
  );
}

type RuntimeWebProviderSelectionParams = {
  kind: "search" | "fetch";
  toolConfig: Record<string, unknown> | undefined;
  enabled: boolean;
  providers: RuntimeWebProvider[];
  configuredProvider?: string;
  metadata: RuntimeWebSearchMetadata;
  diagnostics: RuntimeWebDiagnostic[];
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  context: ResolverContext;
  defaults: SecretDefaults | undefined;
  /** Keep cold-start preparation alive when no configured provider ref can resolve. */
  allowUnavailableProviders?: boolean;
  onUnavailableProviders?: (error: RuntimeWebProviderUnavailableError) => void;
  /** Resolves inline/env/SecretRef credentials and reports the winning source. */
  resolveSecretInput: (
    params: RuntimeWebResolveSecretInputParams,
  ) => Promise<SecretResolutionResult<WebSearchCredentialResolutionSource>>;
};

function ensureConfigObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function inactivePathsForProvider(
  provider: RuntimeWebProvider,
  kind: "search" | "fetch",
): string[] {
  return kind === "search" && provider.requiresCredential === false
    ? []
    : provider.inactiveSecretPaths?.length
      ? provider.inactiveSecretPaths
      : kind === "search" || provider.credentialPath
        ? [provider.credentialPath]
        : [];
}

function pushInactiveProviderCredentialWarnings(params: {
  selection: RuntimeWebProviderSelectionParams;
  skipProviderId?: string;
  details: string;
}): void {
  for (const provider of params.selection.providers) {
    if (provider.id === params.skipProviderId) {
      continue;
    }
    const value = readConfiguredProviderCredential({
      provider,
      config: params.selection.sourceConfig,
      toolConfig: params.selection.toolConfig,
    });
    if (!coerceSecretRef(value, params.selection.defaults)) {
      continue;
    }
    for (const path of inactivePathsForProvider(provider, params.selection.kind)) {
      pushInactiveSurfaceWarning({
        context: params.selection.context,
        path,
        details: params.details,
      });
    }
  }
}

function getProviderEnvVars(provider: object): string[] {
  return "envVars" in provider && Array.isArray(provider.envVars) ? provider.envVars : [];
}

function setResolvedCredentialPath(params: {
  resolvedConfig: OpenClawConfig;
  path: string;
  value: string;
}): void {
  const pathSegments = parseDotPath(params.path);
  if (pathSegments.length === 0) {
    return;
  }
  try {
    setPathExistingStrict(params.resolvedConfig, pathSegments, params.value);
  } catch {
    // Env-only provider defaults may not have a config path to mirror.
  }
}

/**
 * Selects a configured or auto-detected provider and materializes its resolved credential.
 */
export async function resolveRuntimeWebProviderSelection(
  params: RuntimeWebProviderSelectionParams,
): Promise<RuntimeWebProviderSelectionResult> {
  const setResolvedCredential = (provider: RuntimeWebProvider, value: string): void => {
    if (provider.setConfiguredCredentialValue) {
      provider.setConfiguredCredentialValue(params.resolvedConfig, value);
      return;
    }
    const tools = ensureConfigObject(params.resolvedConfig, "tools");
    const web = ensureConfigObject(tools, "web");
    provider.setCredentialValue(ensureConfigObject(web, params.kind), value);
  };
  const scopePath = `tools.web.${params.kind}`;
  const noFallbackCode =
    params.kind === "search"
      ? "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK"
      : "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK";
  if (params.configuredProvider) {
    params.metadata.providerConfigured = params.configuredProvider;
    params.metadata.providerSource = "configured";
  }

  const unavailableProviders: RuntimeWebUnavailableProvider[] = [];
  const resolveProviderContractDigest = (providerId: string) =>
    digestRuntimeWebOwnerContract({ ...params, scopePath, providerId });
  let selectedProvider: string | undefined;
  let selectedPath: string | undefined;
  let selectedResolution: SecretResolutionResult<WebSearchCredentialResolutionSource> | undefined;
  if (params.enabled) {
    const candidates = params.configuredProvider
      ? params.providers.filter((provider) => provider.id === params.configuredProvider)
      : params.providers;
    type UnresolvedProvider = {
      providerId: string;
      path: string;
      ref?: SecretRef;
      refKey?: string;
      reason: SecretDegradationReason;
      contractDigest: string;
      restoreResolvedValue: (value: string) => void;
    };
    const unresolvedWithoutFallback: UnresolvedProvider[] = [];
    const hasProviderRef = (
      entry: UnresolvedProvider,
    ): entry is UnresolvedProvider & { ref: SecretRef; refKey: string } =>
      Boolean(entry.ref && entry.refKey);

    for (const provider of candidates) {
      const contractDigest = resolveProviderContractDigest(provider.id);
      const isKeyless = provider.requiresCredential === false;
      if (isKeyless && !params.configuredProvider && params.kind === "search") {
        continue;
      }

      const path = inactivePathsForProvider(provider, params.kind)[0] ?? "";
      const value = readConfiguredProviderCredential({
        provider,
        config: params.sourceConfig,
        toolConfig: params.toolConfig,
      });
      const resolution = await params.resolveSecretInput({
        providerId: provider.id,
        value,
        path,
        envVars: getProviderEnvVars(provider),
        contractDigest,
      });
      let selectedCandidatePath = path;
      let selectedCandidateResolution = resolution;

      if (!resolution.value && !resolution.secretRefConfigured) {
        const fallback = provider.getConfiguredCredentialFallback?.(params.sourceConfig);
        if (fallback?.value !== undefined) {
          selectedCandidatePath = fallback.path;
          selectedCandidateResolution = await params.resolveSecretInput({
            providerId: provider.id,
            value: fallback.value,
            path: fallback.path,
            envVars: getProviderEnvVars(provider),
            contractDigest,
          });
        }
      } else if (resolution.source === "env" && !resolution.secretRefConfigured) {
        const fallback = provider.getConfiguredCredentialFallback?.(params.sourceConfig);
        if (
          fallback?.value !== undefined &&
          coerceSecretRef(fallback.value, params.defaults) !== null
        ) {
          const fallbackResolution = await params.resolveSecretInput({
            providerId: provider.id,
            value: fallback.value,
            path: fallback.path,
            envVars: getProviderEnvVars(provider),
            contractDigest,
          });
          if (fallbackResolution.source === "secretRef" && fallbackResolution.value) {
            // Preserve transcript/config bytes for env-selected providers while materializing refs.
            setResolvedCredentialPath({
              resolvedConfig: params.resolvedConfig,
              path: fallback.path,
              value: fallbackResolution.value,
            });
          }
        }
      }

      if (
        selectedCandidateResolution.secretRefConfigured &&
        !selectedCandidateResolution.value &&
        selectedCandidateResolution.unresolvedRefReason
      ) {
        unresolvedWithoutFallback.push({
          providerId: provider.id,
          path: selectedCandidatePath,
          ref: selectedCandidateResolution.secretRef,
          refKey: selectedCandidateResolution.secretRefKey,
          reason: selectedCandidateResolution.unresolvedRefReason,
          contractDigest,
          restoreResolvedValue: (resolvedValue) => setResolvedCredential(provider, resolvedValue),
        });
      }

      if (
        isKeyless &&
        selectedCandidateResolution.secretRefConfigured &&
        !selectedCandidateResolution.value
      ) {
        continue;
      }

      if (isKeyless && !params.configuredProvider && !selectedCandidateResolution.value) {
        continue;
      }

      if (params.configuredProvider || isKeyless || selectedCandidateResolution.value) {
        selectedProvider = provider.id;
        selectedPath = selectedCandidatePath;
        selectedResolution = selectedCandidateResolution;
        if (selectedCandidateResolution.value) {
          setResolvedCredentialPath({
            resolvedConfig: params.resolvedConfig,
            path: selectedCandidatePath,
            value: selectedCandidateResolution.value,
          });
          setResolvedCredential(provider, selectedCandidateResolution.value);
        }
        break;
      }
    }

    const recordUnresolvedNoFallback = (unresolved: {
      path: string;
      reason: SecretDegradationReason;
    }) => {
      const diagnostic: RuntimeWebDiagnostic = {
        code: noFallbackCode,
        message: unresolved.reason,
        path: unresolved.path,
      };
      params.diagnostics.push(diagnostic);
      params.metadata.diagnostics.push(diagnostic);
      pushWarning(params.context, {
        code: noFallbackCode,
        path: unresolved.path,
        message: unresolved.reason,
      });
    };
    const failUnresolvedNoFallback = (
      unresolved: UnresolvedProvider,
      related: UnresolvedProvider[] = [unresolved],
    ): never => {
      recordUnresolvedNoFallback(unresolved);
      const relatedUnavailableProviders = related.filter(hasProviderRef);
      if (relatedUnavailableProviders.length > 0) {
        const error = new RuntimeWebProviderUnavailableError(
          noFallbackCode,
          unresolved.reason,
          relatedUnavailableProviders,
        );
        params.onUnavailableProviders?.(error);
        throw error;
      }
      throw new Error(`[${noFallbackCode}] ${unresolved.reason}`);
    };

    if (params.configuredProvider) {
      const unresolved = unresolvedWithoutFallback[0];
      if (unresolved) {
        if (hasProviderRef(unresolved) && params.allowUnavailableProviders) {
          unavailableProviders.push(unresolved);
        } else {
          failUnresolvedNoFallback(unresolved);
        }
      }
    } else {
      if (!selectedProvider && unresolvedWithoutFallback.length > 0) {
        const firstUnresolved = expectDefined(
          unresolvedWithoutFallback[0],
          "unresolved without fallback entry at 0",
        );
        if (!params.allowUnavailableProviders) {
          failUnresolvedNoFallback(firstUnresolved, unresolvedWithoutFallback);
        }
        const unavailable = unresolvedWithoutFallback.filter(hasProviderRef);
        if (unavailable.length !== unresolvedWithoutFallback.length) {
          failUnresolvedNoFallback(firstUnresolved, unresolvedWithoutFallback);
        }
        unavailableProviders.push(...unavailable);
      }

      if (selectedProvider) {
        const selectedProviderEntry = params.providers.find(
          (entry) => entry.id === selectedProvider,
        );
        const selectedDetails =
          selectedProviderEntry?.requiresCredential === false
            ? `${scopePath} auto-detected keyless provider "${selectedProvider}".`
            : `${scopePath} auto-detected provider "${selectedProvider}" from available credentials.`;
        const diagnostic: RuntimeWebDiagnostic = {
          code:
            params.kind === "search"
              ? "WEB_SEARCH_AUTODETECT_SELECTED"
              : "WEB_FETCH_AUTODETECT_SELECTED",
          message: selectedDetails,
          path: `${scopePath}.provider`,
        };
        params.diagnostics.push(diagnostic);
        params.metadata.diagnostics.push(diagnostic);
      }
    }

    if (selectedProvider && unavailableProviders.length === 0) {
      params.metadata.selectedProvider = selectedProvider;
      params.metadata.selectedProviderKeySource = selectedResolution?.source;
      if (!params.configuredProvider) {
        params.metadata.providerSource = "auto-detect";
      }
      const provider = params.providers.find((entry) => entry.id === selectedProvider);
      if (provider?.resolveRuntimeMetadata) {
        Object.assign(
          params.metadata,
          await provider.resolveRuntimeMetadata({
            config: params.sourceConfig,
            ...(params.kind === "search"
              ? { searchConfig: params.toolConfig }
              : { fetchConfig: params.toolConfig }),
            runtimeMetadata: params.metadata,
            resolvedCredential: selectedResolution
              ? {
                  value: selectedResolution.value,
                  source: selectedResolution.source,
                  fallbackEnvVar: selectedResolution.fallbackEnvVar,
                }
              : undefined,
          }),
        );
      }
    }
  }

  if (params.enabled && !params.configuredProvider && params.metadata.selectedProvider) {
    pushInactiveProviderCredentialWarnings({
      selection: params,
      skipProviderId: params.metadata.selectedProvider,
      details: `${scopePath} auto-detected provider is "${params.metadata.selectedProvider}".`,
    });
  } else if (params.toolConfig && !params.enabled) {
    pushInactiveProviderCredentialWarnings({
      selection: params,
      details: `${scopePath} is disabled.`,
    });
  }

  if (params.enabled && params.toolConfig && params.configuredProvider) {
    pushInactiveProviderCredentialWarnings({
      selection: params,
      skipProviderId: params.configuredProvider,
      details: `${scopePath}.provider is "${params.configuredProvider}".`,
    });
  }

  const selectedSecretOwner =
    selectedProvider &&
    selectedPath &&
    selectedResolution?.secretRef &&
    selectedResolution.secretRefKey
      ? {
          providerId: selectedProvider,
          path: selectedPath,
          ref: selectedResolution.secretRef,
          refKey: selectedResolution.secretRefKey,
          contractDigest: resolveProviderContractDigest(selectedProvider),
          ...(selectedResolution.value ? { resolvedValue: selectedResolution.value } : {}),
        }
      : undefined;
  return {
    secretOwners: selectedSecretOwner ? [selectedSecretOwner] : unavailableProviders,
    unavailableProviders,
  };
}

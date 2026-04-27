import { resolveSecretInputRef } from "../config/types.secrets.js";
import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { pushInactiveSurfaceWarning, pushWarning } from "./runtime-shared.js";
export { isRecord } from "./shared.js";
import { isRecord } from "./shared.js";
const loadResolveManifestContractOwnerPluginId = createLazyRuntimeNamedExport(() => import("./runtime-web-tools-manifest.runtime.js"), "resolveManifestContractOwnerPluginId");
function pushInactiveProviderCredentialWarnings(params) {
    for (const provider of params.selection.providers) {
        if (provider.id === params.skipProviderId) {
            continue;
        }
        const value = params.selection.readConfiguredCredential({
            provider,
            config: params.selection.sourceConfig,
            toolConfig: params.selection.toolConfig,
        });
        if (!params.selection.hasConfiguredSecretRef(value, params.selection.defaults)) {
            continue;
        }
        for (const path of params.selection.inactivePathsForProvider(provider)) {
            pushInactiveSurfaceWarning({
                context: params.selection.context,
                path,
                details: params.details,
            });
        }
    }
}
export function ensureObject(target, key) {
    const current = target[key];
    if (isRecord(current)) {
        return current;
    }
    const next = {};
    target[key] = next;
    return next;
}
export function normalizeKnownProvider(value, providers) {
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized) {
        return undefined;
    }
    if (providers.some((provider) => provider.id === normalized)) {
        return normalized;
    }
    return undefined;
}
export function hasConfiguredSecretRef(value, defaults) {
    return Boolean(resolveSecretInputRef({
        value,
        defaults,
    }).ref);
}
export async function resolveRuntimeWebProviderSurface(params) {
    let configuredBundledPluginId = params.configuredBundledPluginIdHint;
    if (!configuredBundledPluginId && params.rawProvider) {
        const resolveManifestContractOwnerPluginId = await loadResolveManifestContractOwnerPluginId();
        configuredBundledPluginId = resolveManifestContractOwnerPluginId({
            contract: params.contract,
            value: params.rawProvider,
            origin: "bundled",
            config: params.sourceConfig,
            env: { ...process.env, ...params.context.env },
        });
    }
    let allProviders = params.sortProviders(await params.resolveProviders({
        configuredBundledPluginId,
    }));
    if (params.rawProvider &&
        params.configuredBundledPluginIdHint &&
        configuredBundledPluginId &&
        !allProviders.some((provider) => provider.id === params.rawProvider)) {
        configuredBundledPluginId = undefined;
    }
    if (params.rawProvider && !configuredBundledPluginId) {
        const resolveManifestContractOwnerPluginId = await loadResolveManifestContractOwnerPluginId();
        configuredBundledPluginId = resolveManifestContractOwnerPluginId({
            contract: params.contract,
            value: params.rawProvider,
            origin: "bundled",
            config: params.sourceConfig,
            env: { ...process.env, ...params.context.env },
        });
        allProviders = params.sortProviders(await params.resolveProviders({
            configuredBundledPluginId,
        }));
    }
    const hasConfiguredSurface = Boolean(params.toolConfig) ||
        allProviders.some((provider) => {
            if (params.ignoreKeylessProvidersForConfiguredSurface &&
                provider.requiresCredential === false) {
                return false;
            }
            return (params.readConfiguredCredential({
                provider,
                config: params.sourceConfig,
                toolConfig: params.toolConfig,
            }) !== undefined);
        });
    const providers = hasConfiguredSurface || !params.emptyProvidersWhenSurfaceMissing ? allProviders : [];
    const configuredProvider = normalizeKnownProvider(params.rawProvider, params.normalizeConfiguredProviderAgainstActiveProviders ? providers : allProviders);
    if (params.rawProvider && !configuredProvider) {
        const diagnostic = {
            code: params.invalidAutoDetectCode,
            message: `${params.providerPath} is "${params.rawProvider}". Falling back to auto-detect precedence.`,
            path: params.providerPath,
        };
        params.diagnostics.push(diagnostic);
        params.metadataDiagnostics.push(diagnostic);
        pushWarning(params.context, {
            code: params.invalidAutoDetectCode,
            path: params.providerPath,
            message: diagnostic.message,
        });
    }
    return {
        providers,
        configuredProvider,
        enabled: hasConfiguredSurface && (!isRecord(params.toolConfig) || params.toolConfig.enabled !== false),
        hasConfiguredSurface,
    };
}
export async function resolveRuntimeWebProviderSelection(params) {
    if (params.configuredProvider) {
        params.metadata.providerConfigured = params.configuredProvider;
        params.metadata.providerSource = "configured";
    }
    if (params.enabled) {
        const candidates = params.configuredProvider
            ? params.providers.filter((provider) => provider.id === params.configuredProvider)
            : params.providers;
        const unresolvedWithoutFallback = [];
        let selectedProvider;
        let selectedResolution;
        let keylessFallbackProvider;
        for (const provider of candidates) {
            if (provider.requiresCredential === false) {
                if (params.deferKeylessFallback && !params.configuredProvider) {
                    keylessFallbackProvider ||= provider;
                    continue;
                }
                selectedProvider = provider.id;
                selectedResolution = {
                    source: "missing",
                    secretRefConfigured: false,
                    fallbackUsedAfterRefFailure: false,
                };
                break;
            }
            const path = params.inactivePathsForProvider(provider)[0] ?? "";
            const value = params.readConfiguredCredential({
                provider,
                config: params.sourceConfig,
                toolConfig: params.toolConfig,
            });
            const resolution = await params.resolveSecretInput({
                value,
                path,
                envVars: "envVars" in provider && Array.isArray(provider.envVars) ? provider.envVars : [],
            });
            if (resolution.secretRefConfigured && resolution.fallbackUsedAfterRefFailure) {
                const diagnostic = {
                    code: params.fallbackUsedCode,
                    message: `${path} SecretRef could not be resolved; using ${resolution.fallbackEnvVar ?? "env fallback"}. ` +
                        (resolution.unresolvedRefReason ?? "").trim(),
                    path,
                };
                params.diagnostics.push(diagnostic);
                params.metadata.diagnostics.push(diagnostic);
                pushWarning(params.context, {
                    code: params.fallbackUsedCode,
                    path,
                    message: diagnostic.message,
                });
            }
            if (resolution.secretRefConfigured && !resolution.value && resolution.unresolvedRefReason) {
                unresolvedWithoutFallback.push({
                    provider: provider.id,
                    path,
                    reason: resolution.unresolvedRefReason,
                });
            }
            if (params.configuredProvider) {
                selectedProvider = provider.id;
                selectedResolution = resolution;
                if (resolution.value) {
                    params.setResolvedCredential({
                        resolvedConfig: params.resolvedConfig,
                        provider,
                        value: resolution.value,
                    });
                }
                break;
            }
            if (resolution.value) {
                selectedProvider = provider.id;
                selectedResolution = resolution;
                params.setResolvedCredential({
                    resolvedConfig: params.resolvedConfig,
                    provider,
                    value: resolution.value,
                });
                break;
            }
        }
        if (!selectedProvider && keylessFallbackProvider) {
            selectedProvider = keylessFallbackProvider.id;
            selectedResolution = {
                source: "missing",
                secretRefConfigured: false,
                fallbackUsedAfterRefFailure: false,
            };
        }
        const failUnresolvedNoFallback = (unresolved) => {
            const diagnostic = {
                code: params.noFallbackCode,
                message: unresolved.reason,
                path: unresolved.path,
            };
            params.diagnostics.push(diagnostic);
            params.metadata.diagnostics.push(diagnostic);
            pushWarning(params.context, {
                code: params.noFallbackCode,
                path: unresolved.path,
                message: unresolved.reason,
            });
            throw new Error(`[${params.noFallbackCode}] ${unresolved.reason}`);
        };
        if (params.configuredProvider) {
            const unresolved = unresolvedWithoutFallback[0];
            if (unresolved) {
                failUnresolvedNoFallback(unresolved);
            }
        }
        else {
            if (!selectedProvider && unresolvedWithoutFallback.length > 0) {
                failUnresolvedNoFallback(unresolvedWithoutFallback[0]);
            }
            if (selectedProvider) {
                const selectedProviderEntry = params.providers.find((entry) => entry.id === selectedProvider);
                const selectedDetails = selectedProviderEntry?.requiresCredential === false
                    ? `${params.scopePath} auto-detected keyless provider "${selectedProvider}" as the default fallback.`
                    : `${params.scopePath} auto-detected provider "${selectedProvider}" from available credentials.`;
                const diagnostic = {
                    code: params.autoDetectSelectedCode,
                    message: selectedDetails,
                    path: `${params.scopePath}.provider`,
                };
                params.diagnostics.push(diagnostic);
                params.metadata.diagnostics.push(diagnostic);
            }
        }
        if (selectedProvider) {
            params.metadata.selectedProvider = selectedProvider;
            params.metadata.selectedProviderKeySource = selectedResolution?.source;
            if (!params.configuredProvider) {
                params.metadata.providerSource = "auto-detect";
            }
            const provider = params.providers.find((entry) => entry.id === selectedProvider);
            if (provider && params.mergeRuntimeMetadata) {
                await params.mergeRuntimeMetadata({
                    provider,
                    metadata: params.metadata,
                    toolConfig: params.toolConfig,
                    selectedResolution,
                });
            }
        }
    }
    if (params.enabled && !params.configuredProvider && params.metadata.selectedProvider) {
        pushInactiveProviderCredentialWarnings({
            selection: params,
            skipProviderId: params.metadata.selectedProvider,
            details: `${params.scopePath} auto-detected provider is "${params.metadata.selectedProvider}".`,
        });
    }
    else if (params.toolConfig && !params.enabled) {
        pushInactiveProviderCredentialWarnings({
            selection: params,
            details: `${params.scopePath} is disabled.`,
        });
    }
    if (params.enabled && params.toolConfig && params.configuredProvider) {
        pushInactiveProviderCredentialWarnings({
            selection: params,
            skipProviderId: params.configuredProvider,
            details: `${params.scopePath}.provider is "${params.configuredProvider}".`,
        });
    }
}

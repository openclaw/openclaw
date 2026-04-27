import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import { resolveManifestProviderAuthChoices } from "../plugins/provider-auth-choices.js";
import { resolveProviderInstallCatalogEntries } from "../plugins/provider-install-catalog.js";
import { resolveProviderModelPickerEntries, resolveProviderWizardOptions, } from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sortFlowContributionsByLabel } from "./types.js";
const DEFAULT_PROVIDER_FLOW_SCOPE = "text-inference";
function includesProviderFlowScope(scopes, scope) {
    return scopes ? scopes.includes(scope) : scope === DEFAULT_PROVIDER_FLOW_SCOPE;
}
function resolveProviderDocsById(params) {
    return new Map(resolvePluginProviders({
        config: params?.config,
        workspaceDir: params?.workspaceDir,
        env: params?.env,
        mode: "setup",
    })
        .filter((provider) => Boolean(normalizeOptionalString(provider.docsPath)))
        .map((provider) => [provider.id, normalizeOptionalString(provider.docsPath)]));
}
function resolveInstallCatalogProviderSetupFlowContributions(params) {
    const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
    const normalizedPluginsConfig = normalizePluginsConfig(params?.config?.plugins);
    return resolveProviderInstallCatalogEntries({
        ...params,
        includeUntrustedWorkspacePlugins: false,
    })
        .filter((entry) => includesProviderFlowScope(entry.onboardingScopes, scope) &&
        resolveEffectiveEnableState({
            id: entry.pluginId,
            origin: entry.origin,
            config: normalizedPluginsConfig,
            rootConfig: params?.config,
            enabledByDefault: true,
        }).enabled)
        .map((entry) => {
        const groupId = entry.groupId ?? entry.providerId;
        const groupLabel = entry.groupLabel ?? entry.label;
        return Object.assign({
            id: `provider:setup:${entry.choiceId}`,
            kind: `provider`,
            surface: `setup`,
            providerId: entry.providerId,
            pluginId: entry.pluginId,
            option: {
                value: entry.choiceId,
                label: entry.choiceLabel,
                ...(entry.choiceHint ? { hint: entry.choiceHint } : {}),
                ...(entry.assistantPriority !== undefined
                    ? { assistantPriority: entry.assistantPriority }
                    : {}),
                ...(entry.assistantVisibility
                    ? { assistantVisibility: entry.assistantVisibility }
                    : {}),
                group: {
                    id: groupId,
                    label: groupLabel,
                    ...(entry.groupHint ? { hint: entry.groupHint } : {}),
                },
            },
        }, entry.onboardingScopes ? { onboardingScopes: [...entry.onboardingScopes] } : {}, { source: `install-catalog` });
    });
}
function resolveManifestProviderSetupFlowContributions(params) {
    const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
    return resolveManifestProviderAuthChoices({
        ...params,
        includeUntrustedWorkspacePlugins: false,
    })
        .filter((choice) => includesProviderFlowScope(choice.onboardingScopes, scope))
        .map((choice) => {
        const groupId = choice.groupId ?? choice.providerId;
        const groupLabel = choice.groupLabel ?? choice.choiceLabel;
        return Object.assign({
            id: `provider:setup:${choice.choiceId}`,
            kind: `provider`,
            surface: `setup`,
            providerId: choice.providerId,
            pluginId: choice.pluginId,
            option: {
                value: choice.choiceId,
                label: choice.choiceLabel,
                ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
                ...(choice.assistantPriority !== undefined
                    ? { assistantPriority: choice.assistantPriority }
                    : {}),
                ...(choice.assistantVisibility
                    ? { assistantVisibility: choice.assistantVisibility }
                    : {}),
                group: {
                    id: groupId,
                    label: groupLabel,
                    ...(choice.groupHint ? { hint: choice.groupHint } : {}),
                },
            },
        }, choice.onboardingScopes ? { onboardingScopes: [...choice.onboardingScopes] } : {}, { source: `manifest` });
    });
}
export function resolveProviderSetupFlowContributions(params) {
    const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
    const docsByProvider = resolveProviderDocsById(params ?? {});
    const manifestContributions = resolveManifestProviderSetupFlowContributions({
        ...params,
        scope,
    });
    const seenOptionValues = new Set(manifestContributions.map((contribution) => contribution.option.value));
    const runtimeContributions = resolveProviderWizardOptions(params ?? {})
        .filter((option) => includesProviderFlowScope(option.onboardingScopes, scope))
        .filter((option) => !seenOptionValues.has(option.value))
        .map((option) => Object.assign({
        id: `provider:setup:${option.value}`,
        kind: `provider`,
        surface: `setup`,
        providerId: option.groupId,
        option: {
            value: option.value,
            label: option.label,
            ...(option.hint ? { hint: option.hint } : {}),
            ...(option.assistantPriority !== undefined
                ? { assistantPriority: option.assistantPriority }
                : {}),
            ...(option.assistantVisibility
                ? { assistantVisibility: option.assistantVisibility }
                : {}),
            group: {
                id: option.groupId,
                label: option.groupLabel,
                ...(option.groupHint ? { hint: option.groupHint } : {}),
            },
            ...(docsByProvider.get(option.groupId)
                ? { docs: { path: docsByProvider.get(option.groupId) } }
                : {}),
        },
    }, option.onboardingScopes ? { onboardingScopes: [...option.onboardingScopes] } : {}, { source: `runtime` }));
    for (const contribution of runtimeContributions) {
        seenOptionValues.add(contribution.option.value);
    }
    const installCatalogContributions = resolveInstallCatalogProviderSetupFlowContributions({
        ...params,
        scope,
    }).filter((contribution) => !seenOptionValues.has(contribution.option.value));
    return sortFlowContributionsByLabel([
        ...manifestContributions,
        ...runtimeContributions,
        ...installCatalogContributions,
    ]);
}
export function resolveProviderModelPickerFlowEntries(params) {
    return resolveProviderModelPickerFlowContributions(params).map((contribution) => contribution.option);
}
export function resolveProviderModelPickerFlowContributions(params) {
    const docsByProvider = resolveProviderDocsById(params ?? {});
    return sortFlowContributionsByLabel(resolveProviderModelPickerEntries(params ?? {}).map((entry) => {
        const providerId = entry.value.startsWith("provider-plugin:")
            ? entry.value.slice("provider-plugin:".length).split(":")[0]
            : entry.value;
        return {
            id: `provider:model-picker:${entry.value}`,
            kind: "provider",
            surface: "model-picker",
            providerId,
            option: {
                value: entry.value,
                label: entry.label,
                ...(entry.hint ? { hint: entry.hint } : {}),
                ...(docsByProvider.get(providerId)
                    ? { docs: { path: docsByProvider.get(providerId) } }
                    : {}),
            },
            source: "runtime",
        };
    }));
}
export { includesProviderFlowScope };

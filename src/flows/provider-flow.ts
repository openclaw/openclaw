import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import * as providerAuthChoices from "../plugins/provider-auth-choices.js";
import * as providerInstallCatalog from "../plugins/provider-install-catalog.js";
import type { FlowContribution, FlowOption } from "./types.js";
import { sortFlowContributionsByLabel } from "./types.js";

type ProviderFlowScope = "text-inference" | "image-generation" | "music-generation";

const DEFAULT_PROVIDER_FLOW_SCOPE: ProviderFlowScope = "text-inference";

type ProviderSetupFlowParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope | "all";
};

type ProviderSetupFlowOption = FlowOption & {
  onboardingScopes?: ProviderFlowScope[];
  onboardingFeatured?: boolean;
};

type ProviderSetupFlowContribution = FlowContribution & {
  kind: "provider";
  surface: "setup";
  providerId: string;
  pluginId?: string;
  option: ProviderSetupFlowOption;
  onboardingScopes?: ProviderFlowScope[];
  source: "manifest" | "install-catalog";
};

function includesProviderFlowScope(
  scopes: readonly ProviderFlowScope[] | undefined,
  scope: ProviderFlowScope | "all",
): boolean {
  // Missing scope means the historic text-inference onboarding surface only.
  return (
    scope === "all" || (scopes ? scopes.includes(scope) : scope === DEFAULT_PROVIDER_FLOW_SCOPE)
  );
}

function buildProviderSetupFlowContribution(
  choice: providerAuthChoices.ProviderAuthChoiceMetadata,
  source: ProviderSetupFlowContribution["source"],
  fallbackGroupLabel: string,
): ProviderSetupFlowContribution {
  const groupId = choice.groupId ?? choice.providerId;
  const groupLabel = choice.groupLabel ?? fallbackGroupLabel;
  return {
    id: `provider:setup:${choice.choiceId}`,
    kind: "provider",
    surface: "setup",
    providerId: choice.providerId,
    pluginId: choice.pluginId,
    option: {
      value: choice.choiceId,
      ...(choice.modelTarget ? { modelTarget: choice.modelTarget } : {}),
      label: choice.choiceLabel,
      ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
      ...(choice.assistantPriority !== undefined
        ? { assistantPriority: choice.assistantPriority }
        : {}),
      ...(choice.assistantVisibility ? { assistantVisibility: choice.assistantVisibility } : {}),
      ...(source === "manifest" && choice.onboardingFeatured ? { onboardingFeatured: true } : {}),
      group: {
        id: groupId,
        label: groupLabel,
        ...(choice.groupHint ? { hint: choice.groupHint } : {}),
      },
    },
    ...(choice.onboardingScopes ? { onboardingScopes: [...choice.onboardingScopes] } : {}),
    source,
  };
}

function resolveInstallCatalogProviderSetupFlowContributions(
  params?: ProviderSetupFlowParams,
): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  const normalizedPluginsConfig = normalizePluginsConfig(params?.config?.plugins);
  return providerInstallCatalog
    .resolveProviderInstallCatalogEntries({
      ...params,
      includeUntrustedWorkspacePlugins: false,
    })
    .filter(
      (entry) =>
        includesProviderFlowScope(entry.onboardingScopes, scope) &&
        resolveEffectiveEnableState({
          id: entry.pluginId,
          origin: entry.origin,
          config: normalizedPluginsConfig,
          rootConfig: params?.config,
          enabledByDefault: true,
        }).enabled,
    )
    .map((entry) => buildProviderSetupFlowContribution(entry, "install-catalog", entry.label));
}

function resolveManifestProviderSetupFlowContributions(
  params?: ProviderSetupFlowParams,
): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  return providerAuthChoices
    .resolveManifestProviderAuthChoices({
      ...params,
      includeUntrustedWorkspacePlugins: false,
    })
    .filter((choice) => includesProviderFlowScope(choice.onboardingScopes, scope))
    .map((choice) => buildProviderSetupFlowContribution(choice, "manifest", choice.choiceLabel));
}

export function resolveProviderSetupFlowContributions(
  params?: ProviderSetupFlowParams,
): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  const manifestContributions = resolveManifestProviderSetupFlowContributions({
    ...params,
    scope,
  });
  const seenOptionValues = new Set(
    manifestContributions.map((contribution) => contribution.option.value),
  );
  const installCatalogContributions = resolveInstallCatalogProviderSetupFlowContributions({
    ...params,
    scope,
  }).filter((contribution) => !seenOptionValues.has(contribution.option.value));
  return sortFlowContributionsByLabel([...manifestContributions, ...installCatalogContributions]);
}

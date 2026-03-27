import type { OpenClawConfig } from "../config/config.js";
import { resolveManifestProviderAuthChoices } from "../plugins/provider-auth-choices.js";
import {
  resolveProviderModelPickerEntries,
  resolveProviderWizardOptions,
} from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { FlowContribution, FlowOption } from "./types.js";
import { mergeFlowContributions, sortFlowContributionsByLabel } from "./types.js";

export type ProviderFlowScope = "text-inference" | "image-generation";

const DEFAULT_PROVIDER_FLOW_SCOPE: ProviderFlowScope = "text-inference";

export type ProviderSetupFlowOption = FlowOption & {
  onboardingScopes?: ProviderFlowScope[];
};

export type ProviderModelPickerFlowEntry = FlowOption;

export type ProviderSetupFlowContribution = FlowContribution & {
  kind: "provider";
  surface: "setup";
  providerId: string;
  pluginId?: string;
  option: ProviderSetupFlowOption;
  onboardingScopes?: ProviderFlowScope[];
  source: "manifest" | "runtime";
};

export type ProviderModelPickerFlowContribution = FlowContribution & {
  kind: "provider";
  surface: "model-picker";
  providerId: string;
  option: ProviderModelPickerFlowEntry;
  source: "runtime";
};

function includesProviderFlowScope(
  scopes: readonly ProviderFlowScope[] | undefined,
  scope: ProviderFlowScope,
): boolean {
  return scopes ? scopes.includes(scope) : scope === DEFAULT_PROVIDER_FLOW_SCOPE;
}

function resolveProviderDocsById(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Map<string, string> {
  return new Map(
    resolvePluginProviders({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
    })
      .filter((provider): provider is ProviderPlugin & { docsPath: string } =>
        Boolean(provider.docsPath?.trim()),
      )
      .map((provider) => [provider.id, provider.docsPath.trim()]),
  );
}

export function resolveManifestProviderSetupFlowOptions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowOption[] {
  return resolveManifestProviderSetupFlowContributions(params).map(
    (contribution) => contribution.option,
  );
}

export function resolveManifestProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  const docsByProvider = resolveProviderDocsById(params ?? {});
  return resolveManifestProviderAuthChoices(params)
    .filter((choice) => includesProviderFlowScope(choice.onboardingScopes, scope))
    .map((choice) => ({
      id: `provider:setup:${choice.choiceId}`,
      kind: "provider" as const,
      surface: "setup" as const,
      providerId: choice.providerId,
      pluginId: choice.pluginId,
      option: {
        value: choice.choiceId,
        label: choice.choiceLabel,
        ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
        ...(choice.groupId && choice.groupLabel
          ? {
              group: {
                id: choice.groupId,
                label: choice.groupLabel,
                ...(choice.groupHint ? { hint: choice.groupHint } : {}),
              },
            }
          : {}),
        ...(docsByProvider.get(choice.providerId)
          ? { docs: { path: docsByProvider.get(choice.providerId)! } }
          : {}),
      },
      ...(choice.onboardingScopes ? { onboardingScopes: [...choice.onboardingScopes] } : {}),
      source: "manifest" as const,
    }));
}

export function resolveRuntimeFallbackProviderSetupFlowOptions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowOption[] {
  return resolveRuntimeFallbackProviderSetupFlowContributions(params).map(
    (contribution) => contribution.option,
  );
}

export function resolveRuntimeFallbackProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  return resolveProviderWizardOptions(params ?? {})
    .filter((option) => includesProviderFlowScope(option.onboardingScopes, scope))
    .map((option) => ({
      id: `provider:setup:${option.value}`,
      kind: "provider" as const,
      surface: "setup" as const,
      providerId: option.groupId,
      option: {
        value: option.value,
        label: option.label,
        ...(option.hint ? { hint: option.hint } : {}),
        group: {
          id: option.groupId,
          label: option.groupLabel,
          ...(option.groupHint ? { hint: option.groupHint } : {}),
        },
      },
      ...(option.onboardingScopes ? { onboardingScopes: [...option.onboardingScopes] } : {}),
      source: "runtime" as const,
    }));
}

export function resolveProviderSetupFlowOptions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowOption[] {
  return resolveProviderSetupFlowContributions(params).map((contribution) => contribution.option);
}

export function resolveProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  return sortFlowContributionsByLabel(
    mergeFlowContributions({
      primary: resolveManifestProviderSetupFlowContributions(params),
      fallbacks: resolveRuntimeFallbackProviderSetupFlowContributions(params),
    }),
  );
}

export function resolveProviderModelPickerFlowEntries(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowEntry[] {
  return resolveProviderModelPickerFlowContributions(params).map(
    (contribution) => contribution.option,
  );
}

export function resolveProviderModelPickerFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowContribution[] {
  const docsByProvider = resolveProviderDocsById(params ?? {});
  return sortFlowContributionsByLabel(
    resolveProviderModelPickerEntries(params ?? {}).map((entry) => {
      const providerId = entry.value.startsWith("provider-plugin:")
        ? entry.value.slice("provider-plugin:".length).split(":")[0]
        : entry.value;
      return {
        id: `provider:model-picker:${entry.value}`,
        kind: "provider" as const,
        surface: "model-picker" as const,
        providerId,
        option: {
          value: entry.value,
          label: entry.label,
          ...(entry.hint ? { hint: entry.hint } : {}),
          ...(docsByProvider.get(providerId)
            ? { docs: { path: docsByProvider.get(providerId)! } }
            : {}),
        },
        source: "runtime" as const,
      };
    }),
  );
}

export { includesProviderFlowScope };

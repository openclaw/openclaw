import type { OpenClawConfig } from "../config/config.js";
import { normalizeProviderIdForAuth } from "../agents/model-selection.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

export type ProviderAuthChoiceMetadata = {
  pluginId: string;
  providerId: string;
  methodId: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  deprecatedChoiceIds?: string[];
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  onboardingScopes?: ("text-inference" | "image-generation")[];
};

export type ProviderOnboardAuthFlag = {
  optionKey: string;
  authChoice: string;
  cliFlag: string;
  cliOption: string;
  description: string;
};

export function resolveManifestProviderAuthChoices(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
}): ProviderAuthChoiceMetadata[] {
  const registry = loadPluginManifestRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });
  const normalizedConfig = normalizePluginsConfig(params?.config?.plugins);

  return registry.plugins.flatMap((plugin) =>
    plugin.origin === "workspace" &&
    params?.includeUntrustedWorkspacePlugins === false &&
    !resolveEffectiveEnableState({
      id: plugin.id,
      origin: plugin.origin,
      config: normalizedConfig,
      rootConfig: params?.config,
    }).enabled
      ? []
      : (plugin.providerAuthChoices ?? []).map((choice) => ({
          pluginId: plugin.id,
          providerId: choice.provider,
          methodId: choice.method,
          choiceId: choice.choiceId,
          choiceLabel: choice.choiceLabel ?? choice.choiceId,
          ...(choice.choiceHint ? { choiceHint: choice.choiceHint } : {}),
          ...(choice.assistantPriority !== undefined
            ? { assistantPriority: choice.assistantPriority }
            : {}),
          ...(choice.assistantVisibility
            ? { assistantVisibility: choice.assistantVisibility }
            : {}),
          ...(choice.deprecatedChoiceIds
            ? { deprecatedChoiceIds: choice.deprecatedChoiceIds }
            : {}),
          ...(choice.groupId ? { groupId: choice.groupId } : {}),
          ...(choice.groupLabel ? { groupLabel: choice.groupLabel } : {}),
          ...(choice.groupHint ? { groupHint: choice.groupHint } : {}),
          ...(choice.optionKey ? { optionKey: choice.optionKey } : {}),
          ...(choice.cliFlag ? { cliFlag: choice.cliFlag } : {}),
          ...(choice.cliOption ? { cliOption: choice.cliOption } : {}),
          ...(choice.cliDescription ? { cliDescription: choice.cliDescription } : {}),
          ...(choice.onboardingScopes ? { onboardingScopes: choice.onboardingScopes } : {}),
        })),
  );
}

export function resolveManifestProviderAuthChoice(
  choiceId: string,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeUntrustedWorkspacePlugins?: boolean;
  },
): ProviderAuthChoiceMetadata | undefined {
  const normalized = choiceId.trim();
  if (!normalized) {
    return undefined;
  }
  return resolveManifestProviderAuthChoices(params).find(
    (choice) => choice.choiceId === normalized,
  );
}

export function resolveManifestProviderApiKeyChoice(params: {
  providerId: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
}): ProviderAuthChoiceMetadata | undefined {
  const normalizedProviderId = normalizeProviderIdForAuth(params.providerId);
  if (!normalizedProviderId) {
    return undefined;
  }

  return resolveManifestProviderAuthChoices(params).find((choice) => {
    if (!choice.optionKey) {
      return false;
    }
    return normalizeProviderIdForAuth(choice.providerId) === normalizedProviderId;
  });
}

export function resolveManifestDeprecatedProviderAuthChoice(
  choiceId: string,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeUntrustedWorkspacePlugins?: boolean;
  },
): ProviderAuthChoiceMetadata | undefined {
  const normalized = choiceId.trim();
  if (!normalized) {
    return undefined;
  }
  return resolveManifestProviderAuthChoices(params).find((choice) =>
    choice.deprecatedChoiceIds?.includes(normalized),
  );
}

export function resolveManifestProviderOnboardAuthFlags(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
}): ProviderOnboardAuthFlag[] {
  const flags: ProviderOnboardAuthFlag[] = [];
  const seen = new Set<string>();

  for (const choice of resolveManifestProviderAuthChoices(params)) {
    if (!choice.optionKey || !choice.cliFlag || !choice.cliOption) {
      continue;
    }
    const dedupeKey = `${choice.optionKey}::${choice.cliFlag}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    flags.push({
      optionKey: choice.optionKey,
      authChoice: choice.choiceId,
      cliFlag: choice.cliFlag,
      cliOption: choice.cliOption,
      description: choice.cliDescription ?? choice.choiceLabel,
    });
  }

  return flags;
}

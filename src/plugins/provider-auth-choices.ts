import type { OpenClawConfig } from "../config/config.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

export type ProviderAuthChoiceMetadata = {
  pluginId: string;
  providerId: string;
  methodId: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint?: string;
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
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
}): ProviderAuthChoiceMetadata[] {
  const registry = loadPluginManifestRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });

  return registry.plugins.flatMap((plugin) =>
    (plugin.providerAuthChoices ?? []).map((choice) => ({
      pluginId: plugin.id,
      providerId: choice.provider,
      methodId: choice.method,
      choiceId: choice.choiceId,
      choiceLabel: choice.choiceLabel ?? choice.choiceId,
      ...(choice.choiceHint ? { choiceHint: choice.choiceHint } : {}),
      ...(choice.groupId ? { groupId: choice.groupId } : {}),
      ...(choice.groupLabel ? { groupLabel: choice.groupLabel } : {}),
      ...(choice.groupHint ? { groupHint: choice.groupHint } : {}),
      ...(choice.optionKey ? { optionKey: choice.optionKey } : {}),
      ...(choice.cliFlag ? { cliFlag: choice.cliFlag } : {}),
      ...(choice.cliOption ? { cliOption: choice.cliOption } : {}),
      ...(choice.cliDescription ? { cliDescription: choice.cliDescription } : {}),
    })),
  );
}

export function resolveManifestProviderAuthChoice(
  choiceId: string,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
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

export function resolveManifestProviderOnboardAuthFlags(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
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

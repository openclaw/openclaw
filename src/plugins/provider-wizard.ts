import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef } from "../agents/model-selection.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolvePluginProviders } from "./providers.js";
import type {
  ProviderAuthMethod,
  ProviderPlugin,
  ProviderPluginWizardModelPicker,
  ProviderPluginWizardOnboarding,
} from "./types.js";

export const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

export type ProviderWizardOption = {
  value: string;
  label: string;
  hint?: string;
  groupId: string;
  groupLabel: string;
  groupHint?: string;
};

export type ProviderModelPickerEntry = {
  value: string;
  label: string;
  hint?: string;
};

function normalizeChoiceId(choiceId: string): string {
  return choiceId.trim();
}

function resolveWizardOnboardingChoiceId(
  provider: ProviderPlugin,
  wizard: ProviderPluginWizardOnboarding,
): string {
  const explicit = wizard.choiceId?.trim();
  if (explicit) {
    return explicit;
  }
  const explicitMethodId = wizard.methodId?.trim();
  if (explicitMethodId) {
    return buildProviderPluginMethodChoice(provider.id, explicitMethodId);
  }
  if (provider.auth.length === 1) {
    return provider.id;
  }
  return buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default");
}

function resolveMethodById(
  provider: ProviderPlugin,
  methodId?: string,
): ProviderAuthMethod | undefined {
  const normalizedMethodId = methodId?.trim().toLowerCase();
  if (!normalizedMethodId) {
    return provider.auth[0];
  }
  return provider.auth.find((method) => method.id.trim().toLowerCase() === normalizedMethodId);
}

function buildOnboardingOptionForMethod(params: {
  provider: ProviderPlugin;
  wizard: ProviderPluginWizardOnboarding;
  method: ProviderAuthMethod;
  value: string;
}): ProviderWizardOption {
  const normalizedGroupId = params.wizard.groupId?.trim() || params.provider.id;
  return {
    value: normalizeChoiceId(params.value),
    label:
      params.wizard.choiceLabel?.trim() ||
      (params.provider.auth.length === 1 ? params.provider.label : params.method.label),
    hint: params.wizard.choiceHint?.trim() || params.method.hint,
    groupId: normalizedGroupId,
    groupLabel: params.wizard.groupLabel?.trim() || params.provider.label,
    groupHint: params.wizard.groupHint?.trim(),
  };
}

export function buildProviderPluginMethodChoice(providerId: string, methodId: string): string {
  return `${PROVIDER_PLUGIN_CHOICE_PREFIX}${providerId.trim()}:${methodId.trim()}`;
}

export function resolveProviderWizardOptions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderWizardOption[] {
  const providers = resolvePluginProviders(params);
  const options: ProviderWizardOption[] = [];

  for (const provider of providers) {
    const wizard = provider.wizard?.onboarding;
    if (!wizard) {
      continue;
    }
    const explicitMethod = resolveMethodById(provider, wizard.methodId);
    if (explicitMethod) {
      options.push(
        buildOnboardingOptionForMethod({
          provider,
          wizard,
          method: explicitMethod,
          value: resolveWizardOnboardingChoiceId(provider, wizard),
        }),
      );
      continue;
    }

    for (const method of provider.auth) {
      options.push(
        buildOnboardingOptionForMethod({
          provider,
          wizard,
          method,
          value: buildProviderPluginMethodChoice(provider.id, method.id),
        }),
      );
    }
  }

  return options;
}

function resolveModelPickerChoiceValue(
  provider: ProviderPlugin,
  modelPicker: ProviderPluginWizardModelPicker,
): string {
  const explicitMethodId = modelPicker.methodId?.trim();
  if (explicitMethodId) {
    return buildProviderPluginMethodChoice(provider.id, explicitMethodId);
  }
  if (provider.auth.length === 1) {
    return provider.id;
  }
  return buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default");
}

export function resolveProviderModelPickerEntries(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerEntry[] {
  const providers = resolvePluginProviders(params);
  const entries: ProviderModelPickerEntry[] = [];

  for (const provider of providers) {
    const modelPicker = provider.wizard?.modelPicker;
    if (!modelPicker) {
      continue;
    }
    entries.push({
      value: resolveModelPickerChoiceValue(provider, modelPicker),
      label: modelPicker.label?.trim() || `${provider.label} (custom)`,
      hint: modelPicker.hint?.trim(),
    });
  }

  return entries;
}

export function resolveProviderPluginChoice(params: {
  providers: ProviderPlugin[];
  choice: string;
}): { provider: ProviderPlugin; method: ProviderAuthMethod } | null {
  const choice = params.choice.trim();
  if (!choice) {
    return null;
  }

  if (choice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)) {
    const payload = choice.slice(PROVIDER_PLUGIN_CHOICE_PREFIX.length);
    const separator = payload.indexOf(":");
    const providerId = separator >= 0 ? payload.slice(0, separator) : payload;
    const methodId = separator >= 0 ? payload.slice(separator + 1) : undefined;
    const provider = params.providers.find(
      (entry) => normalizeProviderId(entry.id) === normalizeProviderId(providerId),
    );
    if (!provider) {
      return null;
    }
    const method = resolveMethodById(provider, methodId);
    return method ? { provider, method } : null;
  }

  for (const provider of params.providers) {
    const onboarding = provider.wizard?.onboarding;
    if (onboarding) {
      const onboardingChoiceId = resolveWizardOnboardingChoiceId(provider, onboarding);
      if (normalizeChoiceId(onboardingChoiceId) === choice) {
        const method = resolveMethodById(provider, onboarding.methodId);
        if (method) {
          return { provider, method };
        }
      }
    }
    if (
      normalizeProviderId(provider.id) === normalizeProviderId(choice) &&
      provider.auth.length > 0
    ) {
      return { provider, method: provider.auth[0] };
    }
  }

  return null;
}

export async function runProviderModelSelectedHook(params: {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const parsed = parseModelRef(params.model, DEFAULT_PROVIDER);
  if (!parsed) {
    return;
  }

  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const provider = providers.find(
    (entry) => normalizeProviderId(entry.id) === normalizeProviderId(parsed.provider),
  );
  if (!provider?.onModelSelected) {
    return;
  }

  await provider.onModelSelected({
    config: params.config,
    model: params.model,
    prompter: params.prompter,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
}

import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef } from "../agents/model-selection.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { resolvePluginProviders } from "./providers.js";
import type {
  ProviderAuthMethod,
  ProviderPlugin,
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

export function buildProviderPluginMethodChoice(providerId: string, methodId: string): string {
  return `${PROVIDER_PLUGIN_CHOICE_PREFIX}${providerId.trim()}:${methodId.trim()}`;
}

export function resolveProviderWizardOptions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderWizardOption[] {
  // Fast path: read wizard metadata from manifests (JSON only, no jiti compilation).
  // Plugins that want to appear in the auth choice must declare wizard.onboarding in their
  // openclaw.plugin.json manifest. This avoids blocking synchronous TypeScript compilation
  // via jiti on every onboarding auth choice prompt render.
  const env = params.env ?? process.env;
  const cfg = params.config ?? {};
  const normalized = normalizePluginsConfig(cfg.plugins);
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: params.workspaceDir,
    env,
  });
  const options: ProviderWizardOption[] = [];
  for (const record of manifestRegistry.plugins) {
    const onboarding = record.wizard?.onboarding;
    if (!onboarding) {
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      config: normalized,
      rootConfig: cfg,
    });
    if (!enableState.enabled) {
      continue;
    }
    const choiceId = onboarding.choiceId?.trim();
    const methodId = onboarding.methodId?.trim();
    const value = choiceId
      ? normalizeChoiceId(choiceId)
      : methodId
        ? buildProviderPluginMethodChoice(record.id, methodId)
        : record.id;
    const groupId = onboarding.groupId?.trim() || record.id;
    options.push({
      value,
      label: onboarding.choiceLabel?.trim() || record.name || record.id,
      hint: onboarding.choiceHint?.trim(),
      groupId,
      groupLabel: onboarding.groupLabel?.trim() || record.name || record.id,
      groupHint: onboarding.groupHint?.trim(),
    });
  }
  return options;
}

export function resolveProviderModelPickerEntries(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerEntry[] {
  // Fast path: read model-picker metadata from manifests (JSON only, no jiti compilation).
  const env = params.env ?? process.env;
  const cfg = params.config ?? {};
  const normalized = normalizePluginsConfig(cfg.plugins);
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: params.workspaceDir,
    env,
  });
  const entries: ProviderModelPickerEntry[] = [];
  for (const record of manifestRegistry.plugins) {
    const modelPicker = record.wizard?.modelPicker;
    if (!modelPicker) {
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      config: normalized,
      rootConfig: cfg,
    });
    if (!enableState.enabled) {
      continue;
    }
    const methodId = modelPicker.methodId?.trim();
    const value = methodId ? buildProviderPluginMethodChoice(record.id, methodId) : record.id;
    entries.push({
      value,
      label: modelPicker.label?.trim() || `${record.name || record.id} (custom)`,
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

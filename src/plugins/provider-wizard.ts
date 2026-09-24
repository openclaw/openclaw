import { expectDefined } from "@openclaw/normalization-core";
/** Provider setup wizard helpers shared by provider plugins and CLI setup flows. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { ProviderAuthChoiceMetadata } from "./provider-auth-choices.js";
import {
  parseProviderPluginMethodChoice,
  buildProviderPluginMethodChoice,
} from "./provider-plugin-choice.js";
import { resolvePluginProvidersCore } from "./providers.runtime.js";
import { resolvePluginSetupProviderCore } from "./setup-registry.js";
import type {
  ProviderAuthMethod,
  ProviderPlugin,
  ProviderPluginWizardModelPicker,
  ProviderPluginWizardSetup,
} from "./types.js";
export { buildProviderPluginMethodChoice } from "./provider-plugin-choice.js";

export type ProviderModelPickerEntry = {
  value: string;
  label: string;
  hint?: string;
};

type ProviderWizardProvidersResolver = (params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerRefs?: readonly string[];
}) => ProviderPlugin[];

let providerWizardProvidersResolverForTest: ProviderWizardProvidersResolver | undefined;

export function setProviderWizardProvidersResolverForTest(
  resolver: ProviderWizardProvidersResolver | undefined,
): () => void {
  const previous = providerWizardProvidersResolverForTest;
  providerWizardProvidersResolverForTest = resolver;
  return () => {
    providerWizardProvidersResolverForTest = previous;
  };
}

function resolveWizardSetupChoiceId(
  provider: ProviderPlugin,
  wizard: ProviderPluginWizardSetup,
): string {
  const explicit = normalizeOptionalString(wizard.choiceId);
  if (explicit) {
    return explicit;
  }
  const explicitMethodId = normalizeOptionalString(wizard.methodId);
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
  const normalizedMethodId = normalizeOptionalLowercaseString(methodId);
  if (!normalizedMethodId) {
    return provider.auth[0];
  }
  return provider.auth.find(
    (method) => normalizeOptionalLowercaseString(method.id) === normalizedMethodId,
  );
}

function listMethodWizardSetups(provider: ProviderPlugin): Array<{
  method: ProviderAuthMethod;
  wizard: ProviderPluginWizardSetup;
}> {
  return provider.auth
    .map((method) => (method.wizard ? { method, wizard: method.wizard } : null))
    .filter((entry): entry is { method: ProviderAuthMethod; wizard: ProviderPluginWizardSetup } =>
      Boolean(entry),
    );
}

function resolveProviderWizardProviders(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerRefs?: readonly string[];
}): ProviderPlugin[] {
  if (providerWizardProvidersResolverForTest) {
    return providerWizardProvidersResolverForTest(params);
  }
  return resolvePluginProvidersCore({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
    ...(params.providerRefs?.length ? { providerRefs: params.providerRefs } : {}),
  });
}

function resolveModelPickerChoiceValue(
  provider: ProviderPlugin,
  modelPicker: ProviderPluginWizardModelPicker,
): string {
  const explicitMethodId = normalizeOptionalString(modelPicker.methodId);
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
  const providers = resolveProviderWizardProviders(params);
  const entries: ProviderModelPickerEntry[] = [];

  for (const provider of providers) {
    const modelPicker = provider.wizard?.modelPicker;
    if (!modelPicker) {
      continue;
    }
    if (resolveMethodById(provider, modelPicker.methodId)?.wizard?.modelTarget === "utility") {
      continue;
    }
    entries.push({
      value: resolveModelPickerChoiceValue(provider, modelPicker),
      label: normalizeOptionalString(modelPicker.label) || `${provider.label} (custom)`,
      hint: normalizeOptionalString(modelPicker.hint),
    });
  }

  return entries;
}

type ProviderManifestChoice = Pick<
  ProviderAuthChoiceMetadata,
  "pluginId" | "providerId" | "methodId" | "choiceId" | "modelTarget"
>;

export function resolveProviderPluginChoiceCore(params: {
  providers: ProviderPlugin[];
  choice: string;
  manifestChoice?: ProviderManifestChoice;
  /** Caller's prepared metadata lookup, bound to the method selected by dispatch. */
  resolveManifestMethodChoice?: (
    provider: ProviderPlugin,
    method: ProviderAuthMethod,
  ) => ProviderManifestChoice | undefined;
}): {
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  wizard?: ProviderPluginWizardSetup;
} | null {
  const choice = normalizeOptionalString(params.choice) ?? "";
  if (!choice) {
    return null;
  }
  const withManifestTarget = (resolved: {
    provider: ProviderPlugin;
    method: ProviderAuthMethod;
    wizard?: ProviderPluginWizardSetup;
  }) => {
    const { provider, method } = resolved;
    const matchesMethod = (declared: ProviderManifestChoice | undefined) =>
      Boolean(
        declared &&
        declared.pluginId === provider.pluginId &&
        normalizeProviderId(declared.providerId) === normalizeProviderId(provider.id) &&
        normalizeOptionalLowercaseString(declared.methodId) ===
          normalizeOptionalLowercaseString(method.id),
      );
    const matching = matchesMethod(params.manifestChoice)
      ? params.manifestChoice
      : params.resolveManifestMethodChoice?.(provider, method);
    return matching?.modelTarget && matchesMethod(matching)
      ? { ...resolved, wizard: { ...resolved.wizard, modelTarget: matching.modelTarget } }
      : resolved;
  };

  const explicitChoice = parseProviderPluginMethodChoice(choice);
  if (explicitChoice) {
    const { providerId, methodId } = explicitChoice;
    const provider = params.providers.find(
      (entry) => normalizeProviderId(entry.id) === normalizeProviderId(providerId),
    );
    if (!provider) {
      return null;
    }
    const method = resolveMethodById(provider, methodId);
    if (!method) {
      return null;
    }
    return withManifestTarget({
      provider,
      method,
      ...(method.wizard ? { wizard: method.wizard } : {}),
    });
  }

  // The manifest owns dispatch; runtime wizard metadata need not repeat its choice ID.
  if (params.manifestChoice) {
    const declared = params.manifestChoice;
    if (declared.choiceId !== choice) {
      return null;
    }
    const provider = params.providers.find(
      (entry) =>
        entry.pluginId === declared.pluginId &&
        normalizeProviderId(entry.id) === normalizeProviderId(declared.providerId),
    );
    const methodId = normalizeOptionalLowercaseString(declared.methodId);
    if (!provider || !methodId) {
      return null;
    }
    const method = resolveMethodById(provider, methodId);
    return method
      ? withManifestTarget({
          provider,
          method,
          wizard: method.wizard,
        })
      : null;
  }

  for (const provider of params.providers) {
    for (const { method, wizard } of listMethodWizardSetups(provider)) {
      const choiceId =
        normalizeOptionalString(wizard.choiceId) ||
        buildProviderPluginMethodChoice(provider.id, method.id);
      if ((normalizeOptionalString(choiceId) ?? "") === choice) {
        return withManifestTarget({ provider, method, wizard });
      }
    }
    const setup = provider.wizard?.setup;
    if (setup) {
      const setupChoiceId = resolveWizardSetupChoiceId(provider, setup);
      if ((normalizeOptionalString(setupChoiceId) ?? "") === choice) {
        const method = resolveMethodById(provider, setup.methodId);
        if (method) {
          return withManifestTarget({ provider, method, wizard: setup });
        }
      }
    }
    if (
      normalizeProviderId(provider.id) === normalizeProviderId(choice) &&
      provider.auth.length > 0
    ) {
      return withManifestTarget({
        provider,
        method: expectDefined(provider.auth[0], "auth entry at 0"),
        ...(provider.auth[0]?.wizard ? { wizard: provider.auth[0].wizard } : {}),
      });
    }
  }

  return null;
}

export async function runProviderModelSelectedHookCore(params: {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  preparedProvider?: ProviderPlugin;
}): Promise<void> {
  const rawModel = params.model.trim();
  if (!rawModel) {
    return;
  }
  const slashIndex = rawModel.indexOf("/");
  const selectedProviderId =
    slashIndex === -1
      ? DEFAULT_PROVIDER
      : normalizeProviderId(rawModel.slice(0, slashIndex).trim());
  if (!selectedProviderId || (slashIndex !== -1 && !rawModel.slice(slashIndex + 1).trim())) {
    return;
  }

  const preparedProvider =
    params.preparedProvider &&
    normalizeProviderId(params.preparedProvider.id) === selectedProviderId
      ? params.preparedProvider
      : undefined;
  const setupProvider =
    preparedProvider ??
    resolvePluginSetupProviderCore({
      provider: selectedProviderId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const provider =
    setupProvider ??
    resolveProviderWizardProviders({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      providerRefs: [selectedProviderId],
    }).find((entry) => normalizeProviderId(entry.id) === selectedProviderId);
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

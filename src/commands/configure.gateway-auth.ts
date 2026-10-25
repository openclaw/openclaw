import { resolveMutableAgentEntry } from "../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  normalizeAgentModelRefForConfig,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "../flows/model-picker.js";
import { resolvePreferredProviderForAuthChoice } from "../plugins/provider-auth-choice-preference.js";
import { resolveManifestProviderAuthChoice } from "../plugins/provider-auth-choices.js";
import { applyPrimaryModel } from "../plugins/provider-model-primary.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice } from "./auth-choice.apply.js";
import { loadStaticManifestCatalogRowsForList } from "./models/list.manifest-catalog.js";
import {
  applyAgentModelDefaults,
  applyOnboardingPrimaryModel,
  applyOnboardingUtilityModel,
  resolveOnboardingAgentTarget,
} from "./onboard-agent-target.js";
import type { ModelWriteTarget, OnboardingAgentTarget } from "./onboard-agent-target.js";
import { promptCustomApiConfig } from "./onboard-custom.js";

type ProviderChoiceModelPrompt = {
  provider?: string;
  allowedKeys?: string[];
  initialSelections?: string[];
  message?: string;
  loadCatalog?: boolean;
};

function hasConfiguredProviderModels(cfg: OpenClawConfig, provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  if ((cfg.models?.providers?.[provider]?.models?.length ?? 0) > 0) {
    return true;
  }
  const providerPrefix = `${provider}/`;
  return Object.keys(cfg.agents?.defaults?.models ?? {}).some((key) =>
    key.trim().startsWith(providerPrefix),
  );
}

function listConfiguredModelProviders(cfg: OpenClawConfig): string[] {
  return Object.entries(cfg.models?.providers ?? {})
    .filter(([, provider]) => (provider.models?.length ?? 0) > 0)
    .map(([provider]) => provider);
}

function resolveSingleConfiguredProvider(cfg: OpenClawConfig): string | undefined {
  const configuredProviders = listConfiguredModelProviders(cfg);
  return configuredProviders.length === 1 ? configuredProviders[0] : undefined;
}

function resolveProviderFromModelRef(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 ? trimmed?.slice(0, slashIndex) : undefined;
}

function resolveCanonicalOpenAISelectionForLegacyCodexPrimary(
  cfg: OpenClawConfig,
  target: OnboardingAgentTarget,
  selectedModels: readonly string[],
  modelWriteTarget: ModelWriteTarget,
): string | undefined {
  const primary = resolveAgentModelPrimaryValue(
    modelWriteTarget === "defaults"
      ? cfg.agents?.defaults?.model
      : (resolveMutableAgentEntry(cfg, target.agentId)?.model ?? cfg.agents?.defaults?.model),
  );
  const modelId = primary?.startsWith("codex/") ? primary.slice("codex/".length).trim() : "";
  if (!modelId) {
    return undefined;
  }
  const canonical = `openai/${modelId}`;
  return selectedModels.find((model) => model.trim() === canonical);
}

function applySelectedPrimary(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
  model: string,
  modelWriteTarget: ModelWriteTarget,
): OpenClawConfig {
  switch (modelWriteTarget) {
    case "defaults":
      return applyPrimaryModel(config, model);
    case "agent":
      return applyOnboardingPrimaryModel(config, target, model);
    default: {
      const exhaustive: never = modelWriteTarget;
      return exhaustive;
    }
  }
}

function applySharedUtilityModel(config: OpenClawConfig, model: string): OpenClawConfig {
  const primary = normalizeAgentModelRefForConfig(model);
  const existing = config.agents?.defaults?.utilityModel;
  const utilityModel = typeof existing === "object" ? { ...existing, primary } : primary;
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, utilityModel },
    },
  };
}

function applySelectedUtilityModel(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
  model: string,
  modelWriteTarget: ModelWriteTarget,
): OpenClawConfig {
  switch (modelWriteTarget) {
    case "defaults":
      return applySharedUtilityModel(config, model);
    case "agent":
      return applyOnboardingUtilityModel(config, target, model);
    default: {
      const exhaustive: never = modelWriteTarget;
      return exhaustive;
    }
  }
}

function hasOwnedPrimary(
  config: OpenClawConfig,
  target: OnboardingAgentTarget,
  modelWriteTarget: ModelWriteTarget,
): boolean {
  switch (modelWriteTarget) {
    case "defaults":
      return Boolean(resolveAgentModelPrimaryValue(config.agents?.defaults?.model));
    case "agent":
      return Boolean(resolveAgentEffectiveModelPrimary(config, target.agentId));
    default: {
      const exhaustive: never = modelWriteTarget;
      return exhaustive;
    }
  }
}

/** Prompt for model provider credentials and explicit default model policy settings. */
export async function promptAuthConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  target: OnboardingAgentTarget = resolveOnboardingAgentTarget(cfg),
  options?: { modelWriteTarget?: ModelWriteTarget },
): Promise<OpenClawConfig> {
  const modelWriteTarget = options?.modelWriteTarget ?? "agent";
  // Pickers project an agent's model state over defaults; shared setup must start from defaults.
  const pickerAgentId = modelWriteTarget === "agent" ? target.agentId : undefined;
  // Shared defaults need credentials in the store every agent inherits, not the setup agent's.
  const credentialAgentDir =
    modelWriteTarget === "agent" ? target.agentDir : resolveSharedMainAuthAgentDir();
  let next = cfg;
  let authChoice = "skip";
  let preferredProvider: string | undefined;
  while (true) {
    authChoice = await promptAuthChoiceGrouped({
      prompter,
      includeSkip: true,
      config: next,
    });

    preferredProvider =
      authChoice === "skip"
        ? undefined
        : await resolvePreferredProviderForAuthChoice({
            choice: authChoice,
            config: next,
          });

    if (authChoice === "custom-api-key") {
      const customResult = await promptCustomApiConfig({
        prompter,
        runtime,
        config: next,
        target,
        modelWriteTarget,
        setAsPrimary: !hasOwnedPrimary(next, target, modelWriteTarget),
      });
      next = customResult.config;
      break;
    }

    if (authChoice === "skip") {
      const modelSelection = await promptDefaultModel({
        config: next,
        prompter,
        allowKeep: true,
        includeProviderPluginSetups: false,
        loadCatalog: true,
        browseCatalogOnDemand: true,
        preferredProvider,
        agentId: pickerAgentId,
        agentDir: target.agentDir,
        workspaceDir: target.workspaceDir,
        runtime,
      });
      if (modelSelection.config) {
        next = modelSelection.config;
      }
      if (modelSelection.model) {
        next = applySelectedPrimary(next, target, modelSelection.model, modelWriteTarget);
        preferredProvider = resolveProviderFromModelRef(modelSelection.model) ?? preferredProvider;
      }
      break;
    }

    const beforeAuthConfig = next;
    const applied = await applyAuthChoice({
      authChoice,
      config: next,
      prompter,
      runtime,
      agentId: target.agentId,
      agentDir: credentialAgentDir,
      setDefaultModel: false,
      preserveExistingDefaultModel: true,
    });
    next = applied.config;
    if (applied.utilityModelOverride) {
      return applySelectedUtilityModel(
        next,
        target,
        applied.utilityModelOverride,
        modelWriteTarget,
      );
    }
    // Auth recommendations initialize an unset primary; reauth must not replace
    // the target's explicit or inherited model.
    if (
      applied.agentModelOverride &&
      !hasOwnedPrimary(beforeAuthConfig, target, modelWriteTarget)
    ) {
      next = applySelectedPrimary(next, target, applied.agentModelOverride, modelWriteTarget);
    }
    if (!hasConfiguredProviderModels(next, preferredProvider)) {
      const beforeProviders = beforeAuthConfig.models?.providers ?? {};
      const configuredProviders = listConfiguredModelProviders(next);
      const changedProviders = configuredProviders.filter((provider) => {
        const beforeCount = beforeProviders[provider]?.models?.length ?? 0;
        const afterCount = next.models?.providers?.[provider]?.models?.length ?? 0;
        return afterCount > beforeCount;
      });
      preferredProvider =
        changedProviders.length === 1
          ? changedProviders[0]
          : (preferredProvider ??
            (configuredProviders.length === 1 ? configuredProviders[0] : undefined));
    }
    if (applied.retrySelection) {
      continue;
    }
    break;
  }

  if (authChoice !== "custom-api-key") {
    const config = next;
    const workspaceDir = target.workspaceDir;
    const env = process.env;
    let modelPrompt: ProviderChoiceModelPrompt | undefined;
    const { resolvePluginProviders, resolveProviderPluginChoice } =
      await import("../plugins/provider-auth-choice.runtime.js");
    const providers = resolvePluginProviders({ config, workspaceDir, env, mode: "setup" });
    const resolved = resolveProviderPluginChoice({
      providers,
      choice: authChoice,
      manifestChoice: resolveManifestProviderAuthChoice(authChoice, {
        config,
        workspaceDir,
        env,
        includeUntrustedWorkspacePlugins: false,
      }),
    });
    const wizard = resolved?.provider.wizard?.setup;
    if (!wizard) {
      modelPrompt = resolved?.provider.id ? { provider: resolved.provider.id } : undefined;
    } else {
      modelPrompt = {
        provider: resolved.provider.id,
        ...wizard.modelAllowlist,
        ...(wizard.modelSelection?.promptWhenAuthChoiceProvided === true
          ? { loadCatalog: true }
          : {}),
      };
    }
    const promptProvider =
      modelPrompt?.provider ?? preferredProvider ?? resolveSingleConfiguredProvider(next);
    const hasPromptProviderConfiguredModels = hasConfiguredProviderModels(next, promptProvider);
    const hasPromptProviderStaticManifestRows = Boolean(
      promptProvider &&
      loadStaticManifestCatalogRowsForList({ cfg: next, providerFilter: promptProvider }).length >
        0,
    );
    const shouldLoadModelCatalog =
      modelPrompt?.loadCatalog ??
      (hasPromptProviderConfiguredModels || hasPromptProviderStaticManifestRows);
    const useProviderScopedCatalog = Boolean(
      promptProvider &&
      shouldLoadModelCatalog &&
      (modelPrompt?.loadCatalog === true || hasPromptProviderConfiguredModels),
    );
    const allowlistSelection = await promptModelAllowlist({
      config: next,
      prompter,
      agentId: pickerAgentId,
      agentDir: target.agentDir,
      workspaceDir: target.workspaceDir,
      env: process.env,
      allowedKeys: modelPrompt?.allowedKeys,
      initialSelections: modelPrompt?.initialSelections,
      message: modelPrompt?.message,
      preferredProvider: promptProvider,
      providerScopedCatalog: useProviderScopedCatalog,
      loadCatalog: shouldLoadModelCatalog,
    });
    if (allowlistSelection.models) {
      const selectedModels = allowlistSelection.models;
      const canonicalPrimary = resolveCanonicalOpenAISelectionForLegacyCodexPrimary(
        next,
        target,
        selectedModels,
        modelWriteTarget,
      );
      if (canonicalPrimary) {
        next = applySelectedPrimary(next, target, canonicalPrimary, modelWriteTarget);
      }
      const withAllowlist = (projected: OpenClawConfig) =>
        applyModelAllowlist(
          applyModelFallbacksFromSelection(projected, selectedModels, {
            scopeKeys: allowlistSelection.scopeKeys,
          }),
          selectedModels,
          { scopeKeys: allowlistSelection.scopeKeys },
        );
      next =
        modelWriteTarget === "defaults"
          ? withAllowlist(next)
          : applyAgentModelDefaults(next, target, withAllowlist);
    }
  }

  return next;
}

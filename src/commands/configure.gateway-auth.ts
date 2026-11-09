import { resolveMutableAgentEntry } from "../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { resolveConfiguredModelPolicyAllow } from "../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { applyModelAllowlist } from "../flows/model-picker-allowlist.js";
import {
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "../flows/model-picker.js";
import { resolvePreferredProviderForAuthChoice } from "../plugins/provider-auth-choice-preference.js";
import { resolveManifestProviderAuthChoice } from "../plugins/provider-auth-choices.js";
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
import type { OnboardingAgentTarget } from "./onboard-agent-target.js";
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
): string | undefined {
  const primary = resolveAgentModelPrimaryValue(
    resolveMutableAgentEntry(cfg, target.agentId)?.model ?? cfg.agents?.defaults?.model,
  );
  const modelId = primary?.startsWith("codex/") ? primary.slice("codex/".length).trim() : "";
  if (!modelId) {
    return undefined;
  }
  const canonical = `openai/${modelId}`;
  return selectedModels.find((model) => model.trim() === canonical);
}

/** Prompt for model provider credentials and explicit default model policy settings. */
export async function promptAuthConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  target: OnboardingAgentTarget = resolveOnboardingAgentTarget(cfg),
): Promise<OpenClawConfig> {
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
        setAsPrimary: !resolveAgentEffectiveModelPrimary(next, target.agentId),
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
        agentId: target.agentId,
        agentDir: target.agentDir,
        workspaceDir: target.workspaceDir,
        runtime,
      });
      if (modelSelection.config) {
        next = modelSelection.config;
      }
      if (modelSelection.model) {
        next = applyOnboardingPrimaryModel(next, target, modelSelection.model);
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
      agentDir: target.agentDir,
      setDefaultModel: false,
      preserveExistingDefaultModel: true,
    });
    next = applied.config;
    if (applied.utilityModelOverride) {
      return applyOnboardingUtilityModel(next, target, applied.utilityModelOverride);
    }
    // Auth recommendations initialize an unset primary; reauth must not replace
    // the target's explicit or inherited model.
    if (
      applied.agentModelOverride &&
      !resolveAgentEffectiveModelPrimary(beforeAuthConfig, target.agentId)
    ) {
      next = applyOnboardingPrimaryModel(next, target, applied.agentModelOverride);
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

  // Configure never creates a model allowlist. Judge from the saved config: wizard steps
  // add model metadata that an unmarked in-memory config would read as a legacy allowlist.
  const hasAllowlist =
    resolveConfiguredModelPolicyAllow({ cfg, agentId: target.agentId }).refs.length > 0;

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
      agentId: target.agentId,
      agentDir: target.agentDir,
      workspaceDir: target.workspaceDir,
      env: process.env,
      allowedKeys: modelPrompt?.allowedKeys,
      initialSelections: modelPrompt?.initialSelections,
      message: modelPrompt?.message,
      preferredProvider: promptProvider,
      providerScopedCatalog: useProviderScopedCatalog,
      loadCatalog: shouldLoadModelCatalog,
      restrictsPicker: hasAllowlist,
    });
    if (allowlistSelection.models) {
      const selectedModels = allowlistSelection.models;
      const canonicalPrimary = resolveCanonicalOpenAISelectionForLegacyCodexPrimary(
        next,
        target,
        selectedModels,
      );
      if (canonicalPrimary) {
        next = applyOnboardingPrimaryModel(next, target, canonicalPrimary);
      }
      const { scopeKeys } = allowlistSelection;
      next = applyAgentModelDefaults(next, target, (projected) => {
        // An unscoped selection edits the saved policy as a whole; its entries can be
        // wildcards, which are not fallback models.
        const withFallbacks =
          hasAllowlist && !scopeKeys
            ? projected
            : applyModelFallbacksFromSelection(projected, selectedModels, {
                scopeKeys,
                fallbacksOnly: !hasAllowlist,
              });
        return hasAllowlist
          ? applyModelAllowlist(withFallbacks, selectedModels, { scopeKeys })
          : withFallbacks;
      });
    }
  }

  return next;
}

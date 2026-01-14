import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import type { ClawdbotConfig, GatewayAuthConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyPrimaryModel, promptDefaultModel } from "./model-picker.js";

type GatewayAuthChoice = "off" | "token" | "password";

export function buildGatewayAuthConfig(params: {
  existing?: GatewayAuthConfig;
  mode: GatewayAuthChoice;
  token?: string;
  password?: string;
}): GatewayAuthConfig | undefined {
  const allowTailscale = params.existing?.allowTailscale;
  const base: GatewayAuthConfig = {};
  if (typeof allowTailscale === "boolean") base.allowTailscale = allowTailscale;

  if (params.mode === "off") {
    return Object.keys(base).length > 0 ? base : undefined;
  }
  if (params.mode === "token") {
    return { ...base, mode: "token", token: params.token };
  }
  return { ...base, mode: "password", password: params.password };
}

export async function promptAuthConfig(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<ClawdbotConfig> {
  const authChoice = await promptAuthChoiceGrouped({
    prompter,
    store: ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    }),
    includeSkip: true,
    includeClaudeCliIfMissing: true,
  });

  let next = cfg;
  if (authChoice !== "skip") {
    const applied = await applyAuthChoice({
      authChoice,
      config: next,
      prompter,
      runtime,
      setDefaultModel: true,
    });
    next = applied.config;
    // Auth choice already set a sensible default model; skip the model picker.
    return next;
  }

  const modelSelection = await promptDefaultModel({
    config: next,
    prompter,
    allowKeep: true,
    ignoreAllowlist: true,
    preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
  });
  if (modelSelection.model) {
    next = applyPrimaryModel(next, modelSelection.model);
  }

  return next;
}

import { resolveEnvApiKey } from "../agents/model-auth.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { formatApiKeyPreview } from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import type { SecretInputMode } from "./onboard-types.js";

const INLINE_ENV_REF_RE = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
const ENV_SOURCE_LABEL_RE = /(?:^|:\s)([A-Z][A-Z0-9_]*)$/;

function extractEnvVarFromSourceLabel(source: string): string | undefined {
  const match = ENV_SOURCE_LABEL_RE.exec(source.trim());
  return match?.[1];
}

export function createAuthChoiceAgentModelNoter(
  params: ApplyAuthChoiceParams,
): (model: string) => Promise<void> {
  return async (model: string) => {
    if (!params.agentId) {
      return;
    }
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };
}

export interface ApplyAuthChoiceModelState {
  config: ApplyAuthChoiceParams["config"];
  agentModelOverride: string | undefined;
}

export function createAuthChoiceModelStateBridge(bindings: {
  getConfig: () => ApplyAuthChoiceParams["config"];
  setConfig: (config: ApplyAuthChoiceParams["config"]) => void;
  getAgentModelOverride: () => string | undefined;
  setAgentModelOverride: (model: string | undefined) => void;
}): ApplyAuthChoiceModelState {
  return {
    get config() {
      return bindings.getConfig();
    },
    set config(config) {
      bindings.setConfig(config);
    },
    get agentModelOverride() {
      return bindings.getAgentModelOverride();
    },
    set agentModelOverride(model) {
      bindings.setAgentModelOverride(model);
    },
  };
}

export function createAuthChoiceDefaultModelApplier(
  params: ApplyAuthChoiceParams,
  state: ApplyAuthChoiceModelState,
): (
  options: Omit<
    Parameters<typeof applyDefaultModelChoice>[0],
    "config" | "setDefaultModel" | "noteAgentModel" | "prompter"
  >,
) => Promise<void> {
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);

  return async (options) => {
    const applied = await applyDefaultModelChoice({
      config: state.config,
      setDefaultModel: params.setDefaultModel,
      noteAgentModel,
      prompter: params.prompter,
      ...options,
    });
    state.config = applied.config;
    state.agentModelOverride = applied.agentModelOverride ?? state.agentModelOverride;
  };
}

export function normalizeTokenProviderInput(
  tokenProvider: string | null | undefined,
): string | undefined {
  const normalized = String(tokenProvider ?? "")
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

export function normalizeSecretInputModeInput(
  secretInputMode: string | null | undefined,
): SecretInputMode | undefined {
  const normalized = String(secretInputMode ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "plaintext" || normalized === "ref") {
    return normalized;
  }
  return undefined;
}

export async function resolveSecretInputModeForEnvSelection(params: {
  prompter: WizardPrompter;
  explicitMode?: SecretInputMode;
}): Promise<SecretInputMode> {
  if (params.explicitMode) {
    return params.explicitMode;
  }
  // Some tests pass partial prompt harnesses without a select implementation.
  // Preserve backward-compatible behavior by defaulting to plaintext in that case.
  if (typeof params.prompter.select !== "function") {
    return "plaintext";
  }
  return await params.prompter.select<SecretInputMode>({
    message: "How should OpenClaw store this API key?",
    initialValue: "plaintext",
    options: [
      {
        value: "plaintext",
        label: "Plaintext on disk",
        hint: "Default and fully backward-compatible",
      },
      {
        value: "ref",
        label: "Env secret reference",
        hint: "Stores env ref only (no plaintext key in auth-profiles)",
      },
    ],
  });
}

export async function maybeApplyApiKeyFromOption(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  expectedProviders: string[];
  normalize: (value: string) => string;
  setCredential: (apiKey: string, mode?: SecretInputMode) => Promise<void>;
}): Promise<string | undefined> {
  const tokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  const expectedProviders = params.expectedProviders
    .map((provider) => normalizeTokenProviderInput(provider))
    .filter((provider): provider is string => Boolean(provider));
  if (!params.token || !tokenProvider || !expectedProviders.includes(tokenProvider)) {
    return undefined;
  }
  const apiKey = params.normalize(params.token);
  await params.setCredential(apiKey, params.secretInputMode);
  return apiKey;
}

export async function ensureApiKeyFromOptionEnvOrPrompt(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  expectedProviders: string[];
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  setCredential: (apiKey: string, mode?: SecretInputMode) => Promise<void>;
  noteMessage?: string;
  noteTitle?: string;
}): Promise<string> {
  const optionApiKey = await maybeApplyApiKeyFromOption({
    token: params.token,
    tokenProvider: params.tokenProvider,
    secretInputMode: params.secretInputMode,
    expectedProviders: params.expectedProviders,
    normalize: params.normalize,
    setCredential: params.setCredential,
  });
  if (optionApiKey) {
    return optionApiKey;
  }

  if (params.noteMessage) {
    await params.prompter.note(params.noteMessage, params.noteTitle);
  }

  return await ensureApiKeyFromEnvOrPrompt({
    provider: params.provider,
    envLabel: params.envLabel,
    promptMessage: params.promptMessage,
    normalize: params.normalize,
    validate: params.validate,
    prompter: params.prompter,
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
  });
}

export async function ensureApiKeyFromEnvOrPrompt(params: {
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  setCredential: (apiKey: string, mode?: SecretInputMode) => Promise<void>;
}): Promise<string> {
  const envKey = resolveEnvApiKey(params.provider);
  if (envKey) {
    const useExisting = await params.prompter.confirm({
      message: `Use existing ${params.envLabel} (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      const mode = await resolveSecretInputModeForEnvSelection({
        prompter: params.prompter,
        explicitMode: params.secretInputMode,
      });
      const explicitEnvRef =
        mode === "ref"
          ? (() => {
              const envVar = extractEnvVarFromSourceLabel(envKey.source);
              return envVar ? `\${${envVar}}` : envKey.apiKey;
            })()
          : envKey.apiKey;
      await params.setCredential(explicitEnvRef, mode);
      return envKey.apiKey;
    }
  }

  const key = await params.prompter.text({
    message: params.promptMessage,
    validate: params.validate,
  });
  const apiKey = params.normalize(String(key ?? ""));
  if (params.secretInputMode === "ref" && !INLINE_ENV_REF_RE.test(apiKey)) {
    await params.prompter.note(
      "secret-input-mode=ref stores an env reference, not plaintext key input. Enter ${ENV_VAR} to target a specific variable, or keep current input to use the provider default env var.",
      "Ref mode note",
    );
  }
  await params.setCredential(apiKey, params.secretInputMode);
  return apiKey;
}

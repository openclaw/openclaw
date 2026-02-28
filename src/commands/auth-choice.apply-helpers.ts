import { resolveEnvApiKey } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.js";
import { type SecretInput, type SecretRef } from "../config/types.secrets.js";
import { encodeJsonPointerToken } from "../secrets/json-pointer.js";
import { PROVIDER_ENV_VARS } from "../secrets/provider-env-vars.js";
import {
  isValidFileSecretRefId,
  resolveDefaultSecretProviderAlias,
} from "../secrets/ref-contract.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { formatApiKeyPreview } from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import type { SecretInputMode } from "./onboard-types.js";

const ENV_SOURCE_LABEL_RE = /(?:^|:\s)([A-Z][A-Z0-9_]*)$/;
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

type SecretRefChoice = "env" | "provider";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

function extractEnvVarFromSourceLabel(source: string): string | undefined {
  const match = ENV_SOURCE_LABEL_RE.exec(source.trim());
  return match?.[1];
}

function resolveDefaultProviderEnvVar(provider: string): string | undefined {
  const envVars = PROVIDER_ENV_VARS[provider];
  return envVars?.find((candidate) => candidate.trim().length > 0);
}

function resolveDefaultFilePointerId(provider: string): string {
  return `/providers/${encodeJsonPointerToken(provider)}/apiKey`;
}

function resolveRefFallbackInput(params: {
  config: OpenClawConfig;
  provider: string;
  preferredEnvVar?: string;
}): { ref: SecretRef; resolvedValue: string } {
  const fallbackEnvVar = params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider);
  if (!fallbackEnvVar) {
    throw new Error(
      `No default environment variable mapping found for provider "${params.provider}". Set a provider-specific env var, or re-run onboarding in an interactive terminal to configure a ref.`,
    );
  }
  const value = process.env[fallbackEnvVar]?.trim();
  if (!value) {
    throw new Error(
      `Environment variable "${fallbackEnvVar}" is required for --secret-input-mode ref in non-interactive onboarding.`,
    );
  }
  return {
    ref: {
      source: "env",
      provider: resolveDefaultSecretProviderAlias(params.config, "env", {
        preferFirstProviderForSource: true,
      }),
      id: fallbackEnvVar,
    },
    resolvedValue: value,
  };
}

async function resolveApiKeyRefForOnboarding(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  preferredEnvVar?: string;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const defaultEnvVar =
    params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider) ?? "";
  const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
  let sourceChoice: SecretRefChoice = "env";

  while (true) {
    const sourceRaw: SecretRefChoice = await params.prompter.select<SecretRefChoice>({
      message: "Where is this API key stored?",
      initialValue: sourceChoice,
      options: [
        {
          value: "env",
          label: "Environment variable",
          hint: "Reference a variable from your runtime environment",
        },
        {
          value: "provider",
          label: "Configured secret provider",
          hint: "Use a configured file or exec secret provider",
        },
      ],
    });
    const source: SecretRefChoice = sourceRaw === "provider" ? "provider" : "env";
    sourceChoice = source;

    if (source === "env") {
      const envVarRaw = await params.prompter.text({
        message: "Environment variable name",
        initialValue: defaultEnvVar || undefined,
        placeholder: "OPENAI_API_KEY",
        validate: (value) => {
          const candidate = value.trim();
          if (!ENV_SECRET_REF_ID_RE.test(candidate)) {
            return 'Use an env var name like "OPENAI_API_KEY" (uppercase letters, numbers, underscores).';
          }
          if (!process.env[candidate]?.trim()) {
            return `Environment variable "${candidate}" is missing or empty in this session.`;
          }
          return undefined;
        },
      });
      const envCandidate = String(envVarRaw ?? "").trim();
      const envVar =
        envCandidate && ENV_SECRET_REF_ID_RE.test(envCandidate) ? envCandidate : defaultEnvVar;
      if (!envVar) {
        throw new Error(
          `No valid environment variable name provided for provider "${params.provider}".`,
        );
      }
      const ref: SecretRef = {
        source: "env",
        provider: resolveDefaultSecretProviderAlias(params.config, "env", {
          preferFirstProviderForSource: true,
        }),
        id: envVar,
      };
      const resolvedValue = await resolveSecretRefString(ref, {
        config: params.config,
        env: process.env,
      });
      await params.prompter.note(
        `Validated environment variable ${envVar}. OpenClaw will store a reference, not the key value.`,
        "Reference validated",
      );
      return { ref, resolvedValue };
    }

    const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(
      ([, provider]) => provider?.source === "file" || provider?.source === "exec",
    );
    if (externalProviders.length === 0) {
      await params.prompter.note(
        "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.",
        "No providers configured",
      );
      continue;
    }
    const defaultProvider = resolveDefaultSecretProviderAlias(params.config, "file", {
      preferFirstProviderForSource: true,
    });
    const selectedProvider = await params.prompter.select<string>({
      message: "Select secret provider",
      initialValue:
        externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ??
        externalProviders[0]?.[0],
      options: externalProviders.map(([providerName, provider]) => ({
        value: providerName,
        label: providerName,
        hint: provider?.source === "exec" ? "Exec provider" : "File provider",
      })),
    });
    const providerEntry = params.config.secrets?.providers?.[selectedProvider];
    if (!providerEntry || (providerEntry.source !== "file" && providerEntry.source !== "exec")) {
      await params.prompter.note(
        `Provider "${selectedProvider}" is not a file/exec provider.`,
        "Invalid provider",
      );
      continue;
    }
    const idPrompt =
      providerEntry.source === "file"
        ? "Secret id (JSON pointer for json mode, or 'value' for singleValue mode)"
        : "Secret id for the exec provider";
    const idDefault =
      providerEntry.source === "file"
        ? providerEntry.mode === "singleValue"
          ? "value"
          : defaultFilePointer
        : `${params.provider}/apiKey`;
    const idRaw = await params.prompter.text({
      message: idPrompt,
      initialValue: idDefault,
      placeholder: providerEntry.source === "file" ? "/providers/openai/apiKey" : "openai/api-key",
      validate: (value) => {
        const candidate = value.trim();
        if (!candidate) {
          return "Secret id cannot be empty.";
        }
        if (
          providerEntry.source === "file" &&
          providerEntry.mode !== "singleValue" &&
          !isValidFileSecretRefId(candidate)
        ) {
          return 'Use an absolute JSON pointer like "/providers/openai/apiKey".';
        }
        if (
          providerEntry.source === "file" &&
          providerEntry.mode === "singleValue" &&
          candidate !== "value"
        ) {
          return 'singleValue mode expects id "value".';
        }
        return undefined;
      },
    });
    const id = String(idRaw ?? "").trim() || idDefault;
    const ref: SecretRef = {
      source: providerEntry.source,
      provider: selectedProvider,
      id,
    };
    try {
      const resolvedValue = await resolveSecretRefString(ref, {
        config: params.config,
        env: process.env,
      });
      await params.prompter.note(
        `Validated ${providerEntry.source} reference ${selectedProvider}:${id}. OpenClaw will store a reference, not the key value.`,
        "Reference validated",
      );
      return { ref, resolvedValue };
    } catch (error) {
      await params.prompter.note(
        [
          `Could not validate provider reference ${selectedProvider}:${id}.`,
          formatErrorMessage(error),
          "Check your provider configuration and try again.",
        ].join("\n"),
        "Reference check failed",
      );
    }
  }
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
  const selected = await params.prompter.select<SecretInputMode>({
    message: "How do you want to provide this API key?",
    initialValue: "plaintext",
    options: [
      {
        value: "plaintext",
        label: "Paste API key now",
        hint: "Stores the key directly in OpenClaw config",
      },
      {
        value: "ref",
        label: "Use secret reference",
        hint: "Stores a reference to env or configured external secret providers",
      },
    ],
  });
  return selected === "ref" ? "ref" : "plaintext";
}

export async function maybeApplyApiKeyFromOption(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  expectedProviders: string[];
  normalize: (value: string) => string;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
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
  config: OpenClawConfig;
  expectedProviders: string[];
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
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
    config: params.config,
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
  config: OpenClawConfig;
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string> {
  const selectedMode = await resolveSecretInputModeForEnvSelection({
    prompter: params.prompter,
    explicitMode: params.secretInputMode,
  });
  const envKey = resolveEnvApiKey(params.provider);

  if (selectedMode === "ref") {
    if (typeof params.prompter.select !== "function") {
      const fallback = resolveRefFallbackInput({
        config: params.config,
        provider: params.provider,
        preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
      });
      await params.setCredential(fallback.ref, selectedMode);
      return fallback.resolvedValue;
    }
    const resolved = await resolveApiKeyRefForOnboarding({
      provider: params.provider,
      config: params.config,
      prompter: params.prompter,
      preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
    });
    await params.setCredential(resolved.ref, selectedMode);
    return resolved.resolvedValue;
  }

  if (envKey && selectedMode === "plaintext") {
    const useExisting = await params.prompter.confirm({
      message: `Use existing ${params.envLabel} (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      await params.setCredential(envKey.apiKey, selectedMode);
      return envKey.apiKey;
    }
  }

  const key = await params.prompter.text({
    message: params.promptMessage,
    validate: params.validate,
  });
  const apiKey = params.normalize(String(key ?? ""));
  await params.setCredential(apiKey, selectedMode);
  return apiKey;
}

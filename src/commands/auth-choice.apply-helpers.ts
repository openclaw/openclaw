import { resolveEnvApiKey } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  isValidEnvSecretRefId,
  type SecretInput,
  type SecretRef,
} from "../config/types.secrets.js";
import { encodeJsonPointerToken } from "../secrets/json-pointer.js";
import { PROVIDER_ENV_VARS } from "../secrets/provider-env-vars.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
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

type SecretRefChoice = "env" | "provider"; // pragma: allowlist secret

export type SecretInputModePromptCopy = {
  modeMessage?: string;
  plaintextLabel?: string;
  plaintextHint?: string;
  refLabel?: string;
  refHint?: string;
};

export type SecretRefSetupPromptCopy = {
  sourceMessage?: string;
  envVarMessage?: string;
  envVarPlaceholder?: string;
  envVarFormatError?: string;
  envVarMissingError?: (envVar: string) => string;
  noProvidersMessage?: string;
  envValidatedMessage?: (envVar: string) => string;
  providerValidatedMessage?: (provider: string, id: string, source: "file" | "exec") => string;
};

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
      `No default environment variable mapping found for provider "${params.provider}". Set a provider-specific env var, or re-run setup in an interactive terminal to configure a ref.`,
    );
  }
  const value = process.env[fallbackEnvVar]?.trim();
  if (!value) {
    throw new Error(
      `Environment variable "${fallbackEnvVar}" is required for --secret-input-mode ref in non-interactive setup.`,
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

export async function promptSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  preferredEnvVar?: string;
  copy?: SecretRefSetupPromptCopy;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const defaultEnvVar =
    params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider) ?? "";
  const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
  let sourceChoice: SecretRefChoice = "env"; // pragma: allowlist secret

  while (true) {
    const sourceRaw: SecretRefChoice = await params.prompter.select<SecretRefChoice>({
      message: params.copy?.sourceMessage ?? "这个 API Key 存在哪里？",
      initialValue: sourceChoice,
      options: [
        {
          value: "env",
          label: "环境变量",
          hint: "引用你运行环境里的变量",
        },
        {
          value: "provider",
          label: "已配置的密钥提供方",
          hint: "使用已配置的文件或命令式密钥提供方",
        },
      ],
    });
    const source: SecretRefChoice = sourceRaw === "provider" ? "provider" : "env";
    sourceChoice = source;

    if (source === "env") {
      const envVarRaw = await params.prompter.text({
        message: params.copy?.envVarMessage ?? "环境变量名",
        initialValue: defaultEnvVar || undefined,
        placeholder: params.copy?.envVarPlaceholder ?? "OPENAI_API_KEY",
        validate: (value) => {
          const candidate = value.trim();
          if (!isValidEnvSecretRefId(candidate)) {
            return (
              params.copy?.envVarFormatError ??
              '请使用类似 "OPENAI_API_KEY" 的环境变量名（大写字母、数字、下划线）。'
            );
          }
          if (!process.env[candidate]?.trim()) {
            return (
              params.copy?.envVarMissingError?.(candidate) ??
              `当前会话中的环境变量 "${candidate}" 不存在或为空。`
            );
          }
          return undefined;
        },
      });
      const envCandidate = String(envVarRaw ?? "").trim();
      const envVar =
        envCandidate && isValidEnvSecretRefId(envCandidate) ? envCandidate : defaultEnvVar;
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
        params.copy?.envValidatedMessage?.(envVar) ??
          `已验证环境变量 ${envVar}。OpenClaw 将保存引用，而不是密钥值。`,
        "引用已验证",
      );
      return { ref, resolvedValue };
    }

    const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(
      ([, provider]) => provider?.source === "file" || provider?.source === "exec",
    );
    if (externalProviders.length === 0) {
      await params.prompter.note(
        params.copy?.noProvidersMessage ??
          "当前尚未配置文件/命令式密钥提供方。请先在 secrets.providers 下添加，或改用环境变量。",
        "未配置提供方",
      );
      continue;
    }
    const defaultProvider = resolveDefaultSecretProviderAlias(params.config, "file", {
      preferFirstProviderForSource: true,
    });
    const selectedProvider = await params.prompter.select<string>({
      message: "选择密钥提供方",
      initialValue:
        externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ??
        externalProviders[0]?.[0],
      options: externalProviders.map(([providerName, provider]) => ({
        value: providerName,
        label: providerName,
        hint: provider?.source === "exec" ? "命令式提供方" : "文件提供方",
      })),
    });
    const providerEntry = params.config.secrets?.providers?.[selectedProvider];
    if (!providerEntry || (providerEntry.source !== "file" && providerEntry.source !== "exec")) {
      await params.prompter.note(
        `提供方 "${selectedProvider}" 不是文件/命令式提供方。`,
        "提供方无效",
      );
      continue;
    }
    const idPrompt =
      providerEntry.source === "file"
        ? "密钥 ID（json 模式使用 JSON Pointer；singleValue 模式使用 'value'）"
        : "命令式提供方的密钥 ID";
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
          return "密钥 ID 不能为空。";
        }
        if (
          providerEntry.source === "file" &&
          providerEntry.mode !== "singleValue" &&
          !isValidFileSecretRefId(candidate)
        ) {
          return '请使用绝对 JSON Pointer，例如 "/providers/openai/apiKey"。';
        }
        if (
          providerEntry.source === "file" &&
          providerEntry.mode === "singleValue" &&
          candidate !== "value"
        ) {
          return 'singleValue 模式要求 id 为 "value"。';
        }
        if (providerEntry.source === "exec" && !isValidExecSecretRefId(candidate)) {
          return formatExecSecretRefIdValidationMessage();
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
        params.copy?.providerValidatedMessage?.(selectedProvider, id, providerEntry.source) ??
          `已验证 ${providerEntry.source} 引用 ${selectedProvider}:${id}。OpenClaw 将保存引用，而不是密钥值。`,
        "引用已验证",
      );
      return { ref, resolvedValue };
    } catch (error) {
      await params.prompter.note(
        [
          `无法验证提供方引用 ${selectedProvider}:${id}。`,
          formatErrorMessage(error),
          "请检查提供方配置后重试。",
        ].join("\n"),
        "引用校验失败",
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
      `已为智能体 "${params.agentId}" 设置默认模型：${model}。`,
      "模型已配置",
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

export function createAuthChoiceDefaultModelApplierForMutableState(
  params: ApplyAuthChoiceParams,
  getConfig: () => ApplyAuthChoiceParams["config"],
  setConfig: (config: ApplyAuthChoiceParams["config"]) => void,
  getAgentModelOverride: () => string | undefined,
  setAgentModelOverride: (model: string | undefined) => void,
): ReturnType<typeof createAuthChoiceDefaultModelApplier> {
  return createAuthChoiceDefaultModelApplier(
    params,
    createAuthChoiceModelStateBridge({
      getConfig,
      setConfig,
      getAgentModelOverride,
      setAgentModelOverride,
    }),
  );
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
  copy?: SecretInputModePromptCopy;
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
    message: params.copy?.modeMessage ?? "你想用哪种方式提供这个 API Key？",
    initialValue: "plaintext",
    options: [
      {
        value: "plaintext",
        label: params.copy?.plaintextLabel ?? "现在粘贴 API Key",
        hint: params.copy?.plaintextHint ?? "会把密钥直接存进 OpenClaw 配置",
      },
      {
        value: "ref",
        label: params.copy?.refLabel ?? "使用外部密钥提供方",
        hint: params.copy?.refHint ?? "只保存引用，指向环境变量或已配置的外部密钥提供方",
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
    const resolved = await promptSecretRefForSetup({
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
      message: `使用现有的 ${params.envLabel} 吗？（${envKey.source}，${formatApiKeyPreview(envKey.apiKey)}）`,
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

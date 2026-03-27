import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  buildApiKeyCredential,
  type ApiKeyStorageOptions,
  writeOAuthCredentials,
  type WriteOAuthCredentialsOptions,
} from "./provider-auth-helpers.js";
import { HUGGINGFACE_DEFAULT_MODEL_REF } from "../../extensions/huggingface/api.js";
import { LITELLM_DEFAULT_MODEL_REF } from "../../extensions/litellm/api.js";
import { OPENROUTER_DEFAULT_MODEL_REF } from "../../extensions/openrouter/api.js";
import { TOGETHER_DEFAULT_MODEL_REF } from "../../extensions/together/api.js";
import {
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
} from "../../extensions/vercel-ai-gateway/api.js";
import { XIAOMI_DEFAULT_MODEL_REF } from "../../extensions/xiaomi/api.js";
import { ZAI_DEFAULT_MODEL_REF } from "../../extensions/zai/api.js";
import { KILOCODE_DEFAULT_MODEL_REF } from "./provider-model-kilocode.js";

const resolveAuthAgentDir = (agentDir?: string) => agentDir ?? resolveOpenClawAgentDir();

function upsertProviderApiKeyProfile(params: {
  provider: string;
  key: SecretInput;
  agentDir?: string;
  options?: ApiKeyStorageOptions;
  profileId?: string;
  metadata?: Record<string, string>;
}) {
  upsertAuthProfile({
    profileId: params.profileId ?? `${params.provider}:default`,
    credential: buildApiKeyCredential(params.provider, params.key, params.metadata, params.options),
    agentDir: resolveAuthAgentDir(params.agentDir),
  });
}

export {
  HUGGINGFACE_DEFAULT_MODEL_REF,
  KILOCODE_DEFAULT_MODEL_REF,
  LITELLM_DEFAULT_MODEL_REF,
  OPENROUTER_DEFAULT_MODEL_REF,
  TOGETHER_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  XIAOMI_DEFAULT_MODEL_REF,
  ZAI_DEFAULT_MODEL_REF,
};
export {
  buildApiKeyCredential,
  type ApiKeyStorageOptions,
  writeOAuthCredentials,
  type WriteOAuthCredentialsOptions,
};

export async function setAnthropicApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "anthropic", key, agentDir, options });
}

export async function setOpenaiApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "openai", key, agentDir, options });
}

export async function setGeminiApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "google", key, agentDir, options });
}

export async function setMinimaxApiKey(
  key: SecretInput,
  agentDir?: string,
  profileId: string = "minimax:default",
  options?: ApiKeyStorageOptions,
) {
  const provider = profileId.split(":")[0] ?? "minimax";
  upsertProviderApiKeyProfile({ provider, key, agentDir, options, profileId });
}

export async function setMoonshotApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "moonshot", key, agentDir, options });
}

export async function setKimiCodingApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "kimi", key, agentDir, options });
}

export async function setVolcengineApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "volcengine", key, agentDir, options });
}

export async function setByteplusApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "byteplus", key, agentDir, options });
}

export async function setSyntheticApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "synthetic", key, agentDir, options });
}

export async function setVeniceApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "venice", key, agentDir, options });
}

export async function setZaiApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "zai:default",
    credential: buildApiKeyCredential("zai", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setXiaomiApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "xiaomi:default",
    credential: buildApiKeyCredential("xiaomi", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setOpenrouterApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  const safeKey = typeof key === "string" && key === "undefined" ? "" : key;
  upsertAuthProfile({
    profileId: "openrouter:default",
    credential: buildApiKeyCredential("openrouter", safeKey, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setCloudflareAiGatewayConfig(
  accountId: string,
  gatewayId: string,
  apiKey: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  const normalizedAccountId = accountId.trim();
  const normalizedGatewayId = gatewayId.trim();
  upsertProviderApiKeyProfile({
    provider: "cloudflare-ai-gateway",
    key: apiKey,
    agentDir,
    options,
    metadata: {
      accountId: normalizedAccountId,
      gatewayId: normalizedGatewayId,
    },
  });
}

export async function setLitellmApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "litellm", key, agentDir, options });
}

export async function setVercelAiGatewayApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "vercel-ai-gateway", key, agentDir, options });
}

export async function setOpencodeZenApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  await setSharedOpencodeApiKey(key, agentDir, options);
}

export async function setOpencodeGoApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  await setSharedOpencodeApiKey(key, agentDir, options);
}

async function setSharedOpencodeApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  for (const provider of ["opencode", "opencode-go"] as const) {
    upsertProviderApiKeyProfile({ provider, key, agentDir, options });
  }
}

export async function setTogetherApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "together", key, agentDir, options });
}

export async function setHuggingfaceApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "huggingface", key, agentDir, options });
}

export function setQianfanApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "qianfan", key, agentDir, options });
}

export function setModelStudioApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "modelstudio", key, agentDir, options });
}

export function setXaiApiKey(key: SecretInput, agentDir?: string, options?: ApiKeyStorageOptions) {
  upsertProviderApiKeyProfile({ provider: "xai", key, agentDir, options });
}

export async function setMistralApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "mistral", key, agentDir, options });
}

export async function setKilocodeApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertProviderApiKeyProfile({ provider: "kilocode", key, agentDir, options });
}

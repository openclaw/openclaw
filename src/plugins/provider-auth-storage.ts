import { HUGGINGFACE_DEFAULT_MODEL_REF } from "../../extensions/huggingface/api.js";
import { LITELLM_DEFAULT_MODEL_REF } from "../../extensions/litellm/api.js";
import { OPENROUTER_DEFAULT_MODEL_REF } from "../../extensions/openrouter/api.js";
import { TOGETHER_DEFAULT_MODEL_REF } from "../../extensions/together/api.js";
import { VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF } from "../../extensions/vercel-ai-gateway/api.js";
import { XIAOMI_DEFAULT_MODEL_REF } from "../../extensions/xiaomi/api.js";
import { ZAI_DEFAULT_MODEL_REF } from "../../extensions/zai/api.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  buildApiKeyCredential,
  type ApiKeyStorageOptions,
  writeOAuthCredentials,
  type WriteOAuthCredentialsOptions,
} from "./provider-auth-helpers.js";
import { KILOCODE_DEFAULT_MODEL_REF } from "./provider-model-kilocode.js";

const resolveAuthAgentDir = (agentDir?: string) => agentDir ?? resolveOpenClawAgentDir();

type ProviderApiKeySetter = (
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) => Promise<void> | void;

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

function createProviderApiKeySetter(
  provider: string,
  resolveKey: (key: SecretInput) => SecretInput = (key) => key,
): ProviderApiKeySetter {
  return async (key, agentDir, options) => {
    upsertProviderApiKeyProfile({
      provider,
      key: resolveKey(key),
      agentDir,
      options,
    });
  };
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

export const setAnthropicApiKey = createProviderApiKeySetter("anthropic");
export const setOpenaiApiKey = createProviderApiKeySetter("openai");
export const setGeminiApiKey = createProviderApiKeySetter("google");

export async function setMinimaxApiKey(
  key: SecretInput,
  agentDir?: string,
  profileId: string = "minimax:default",
  options?: ApiKeyStorageOptions,
) {
  const provider = profileId.split(":")[0] ?? "minimax";
  upsertProviderApiKeyProfile({ provider, key, agentDir, options, profileId });
}

export const setMoonshotApiKey = createProviderApiKeySetter("moonshot");
export const setKimiCodingApiKey = createProviderApiKeySetter("kimi");
export const setVolcengineApiKey = createProviderApiKeySetter("volcengine");
export const setByteplusApiKey = createProviderApiKeySetter("byteplus");
export const setSyntheticApiKey = createProviderApiKeySetter("synthetic");
export const setVeniceApiKey = createProviderApiKeySetter("venice");
export const setZaiApiKey = createProviderApiKeySetter("zai");
export const setXiaomiApiKey = createProviderApiKeySetter("xiaomi");
export const setOpenrouterApiKey = createProviderApiKeySetter("openrouter", (key) =>
  typeof key === "string" && key === "undefined" ? "" : key,
);

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

export const setLitellmApiKey = createProviderApiKeySetter("litellm");
export const setVercelAiGatewayApiKey = createProviderApiKeySetter("vercel-ai-gateway");

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

export const setTogetherApiKey = createProviderApiKeySetter("together");
export const setHuggingfaceApiKey = createProviderApiKeySetter("huggingface");
export const setQianfanApiKey = createProviderApiKeySetter("qianfan");
export const setModelStudioApiKey = createProviderApiKeySetter("modelstudio");
export const setXaiApiKey = createProviderApiKeySetter("xai");
export const setMistralApiKey = createProviderApiKeySetter("mistral");
export const setKilocodeApiKey = createProviderApiKeySetter("kilocode");

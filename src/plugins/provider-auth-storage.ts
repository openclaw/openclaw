import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  buildApiKeyCredential,
  type ApiKeyStorageOptions,
  writeOAuthCredentials,
  type WriteOAuthCredentialsOptions,
} from "./provider-auth-helpers.js";

const resolveAuthAgentDir = (agentDir?: string) => agentDir ?? resolveOpenClawAgentDir();
const ZAI_DEFAULT_MODEL_REF = "zai/glm-5";
const XIAOMI_DEFAULT_MODEL_REF = "xiaomi/mimo-v2-flash";
const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";
const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";
const LITELLM_DEFAULT_MODEL_REF = "litellm/claude-opus-4-6";
const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";

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

type ProviderApiKeySetterSpec = {
  provider: string;
  resolveKey?: (key: SecretInput) => SecretInput;
};

function createProviderApiKeySetters<const T extends Record<string, ProviderApiKeySetterSpec>>(
  specs: T,
): { [K in keyof T]: ProviderApiKeySetter } {
  const entries = Object.entries(specs).map(([name, spec]) => [
    name,
    createProviderApiKeySetter(spec.provider, spec.resolveKey),
  ]);
  return Object.fromEntries(entries) as { [K in keyof T]: ProviderApiKeySetter };
}

export {
  buildApiKeyCredential,
  type ApiKeyStorageOptions,
  writeOAuthCredentials,
  type WriteOAuthCredentialsOptions,
};

const {
  setAnthropicApiKey,
  setOpenaiApiKey,
  setGeminiApiKey,
  setMoonshotApiKey,
  setKimiCodingApiKey,
  setVolcengineApiKey,
  setByteplusApiKey,
  setSyntheticApiKey,
  setVeniceApiKey,
  setZaiApiKey,
  setXiaomiApiKey,
  setOpenrouterApiKey,
  setLitellmApiKey,
  setVercelAiGatewayApiKey,
  setTogetherApiKey,
  setHuggingfaceApiKey,
  setQianfanApiKey,
  setModelStudioApiKey,
  setXaiApiKey,
  setMistralApiKey,
  setKilocodeApiKey,
} = createProviderApiKeySetters({
  setAnthropicApiKey: { provider: "anthropic" },
  setOpenaiApiKey: { provider: "openai" },
  setGeminiApiKey: { provider: "google" },
  setMoonshotApiKey: { provider: "moonshot" },
  setKimiCodingApiKey: { provider: "kimi" },
  setVolcengineApiKey: { provider: "volcengine" },
  setByteplusApiKey: { provider: "byteplus" },
  setSyntheticApiKey: { provider: "synthetic" },
  setVeniceApiKey: { provider: "venice" },
  setZaiApiKey: { provider: "zai" },
  setXiaomiApiKey: { provider: "xiaomi" },
  setOpenrouterApiKey: {
    provider: "openrouter",
    resolveKey: (key) => (typeof key === "string" && key === "undefined" ? "" : key),
  },
  setLitellmApiKey: { provider: "litellm" },
  setVercelAiGatewayApiKey: { provider: "vercel-ai-gateway" },
  setTogetherApiKey: { provider: "together" },
  setHuggingfaceApiKey: { provider: "huggingface" },
  setQianfanApiKey: { provider: "qianfan" },
  setModelStudioApiKey: { provider: "modelstudio" },
  setXaiApiKey: { provider: "xai" },
  setMistralApiKey: { provider: "mistral" },
  setKilocodeApiKey: { provider: "kilocode" },
});

export {
  setAnthropicApiKey,
  setOpenaiApiKey,
  setGeminiApiKey,
  setMoonshotApiKey,
  setKimiCodingApiKey,
  setVolcengineApiKey,
  setByteplusApiKey,
  setSyntheticApiKey,
  setVeniceApiKey,
  setZaiApiKey,
  setXiaomiApiKey,
  setOpenrouterApiKey,
  setLitellmApiKey,
  setVercelAiGatewayApiKey,
  setTogetherApiKey,
  setHuggingfaceApiKey,
  setQianfanApiKey,
  setModelStudioApiKey,
  setXaiApiKey,
  setMistralApiKey,
  setKilocodeApiKey,
};

export async function setMinimaxApiKey(
  key: SecretInput,
  agentDir?: string,
  profileId: string = "minimax:default",
  options?: ApiKeyStorageOptions,
) {
  const provider = profileId.split(":")[0] ?? "minimax";
  upsertProviderApiKeyProfile({ provider, key, agentDir, options, profileId });
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

import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import type { SecretInput } from "../config/types.secrets.js";
import { KILOCODE_DEFAULT_MODEL_REF } from "../providers/kilocode-shared.js";
import {
  buildApiKeyCredential,
  type ApiKeyStorageOptions,
  writeOAuthCredentials,
  type WriteOAuthCredentialsOptions,
} from "./provider-auth-helpers.js";

const resolveAuthAgentDir = (agentDir?: string) => agentDir ?? resolveOpenClawAgentDir();

export { KILOCODE_DEFAULT_MODEL_REF };
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
  upsertAuthProfile({
    profileId: "anthropic:default",
    credential: buildApiKeyCredential("anthropic", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setOpenaiApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "openai:default",
    credential: buildApiKeyCredential("openai", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setGeminiApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "google:default",
    credential: buildApiKeyCredential("google", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMinimaxApiKey(
  key: SecretInput,
  agentDir?: string,
  profileId: string = "minimax:default",
  options?: ApiKeyStorageOptions,
) {
  const provider = profileId.split(":")[0] ?? "minimax";
  upsertAuthProfile({
    profileId,
    credential: buildApiKeyCredential(provider, key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMoonshotApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "moonshot:default",
    credential: buildApiKeyCredential("moonshot", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setKimiCodingApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "kimi:default",
    credential: buildApiKeyCredential("kimi", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setVolcengineApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "volcengine:default",
    credential: buildApiKeyCredential("volcengine", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setByteplusApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "byteplus:default",
    credential: buildApiKeyCredential("byteplus", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setSyntheticApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "synthetic:default",
    credential: buildApiKeyCredential("synthetic", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setVeniceApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "venice:default",
    credential: buildApiKeyCredential("venice", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export const ZAI_DEFAULT_MODEL_REF = "zai/glm-5";
export const XIAOMI_DEFAULT_MODEL_REF = "xiaomi/mimo-v2-flash";
export const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
export const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";
export const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";
export const LITELLM_DEFAULT_MODEL_REF = "litellm/claude-opus-4-6";
export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";

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
  upsertAuthProfile({
    profileId: "cloudflare-ai-gateway:default",
    credential: buildApiKeyCredential(
      "cloudflare-ai-gateway",
      apiKey,
      {
        accountId: normalizedAccountId,
        gatewayId: normalizedGatewayId,
      },
      options,
    ),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setLitellmApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "litellm:default",
    credential: buildApiKeyCredential("litellm", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setVercelAiGatewayApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "vercel-ai-gateway:default",
    credential: buildApiKeyCredential("vercel-ai-gateway", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
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
    upsertAuthProfile({
      profileId: `${provider}:default`,
      credential: buildApiKeyCredential(provider, key, undefined, options),
      agentDir: resolveAuthAgentDir(agentDir),
    });
  }
}

export async function setTogetherApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "together:default",
    credential: buildApiKeyCredential("together", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setHuggingfaceApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "huggingface:default",
    credential: buildApiKeyCredential("huggingface", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export function setQianfanApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "qianfan:default",
    credential: buildApiKeyCredential("qianfan", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export function setModelStudioApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "modelstudio:default",
    credential: buildApiKeyCredential("modelstudio", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export function setXaiApiKey(key: SecretInput, agentDir?: string, options?: ApiKeyStorageOptions) {
  upsertAuthProfile({
    profileId: "xai:default",
    credential: buildApiKeyCredential("xai", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMistralApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "mistral:default",
    credential: buildApiKeyCredential("mistral", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setKilocodeApiKey(
  key: SecretInput,
  agentDir?: string,
  options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "kilocode:default",
    credential: buildApiKeyCredential("kilocode", key, undefined, options),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

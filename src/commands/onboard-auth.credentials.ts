import type { OAuthCredentials } from "@mariozechner/pi-ai";
import fs from "node:fs";
import path from "node:path";
import type { SecretInput, SecretRef } from "../config/types.secrets.js";
import type { SecretInputMode } from "./onboard-types.js";
import { resolveBotAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
export { CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF } from "../agents/cloudflare-ai-gateway.js";
export { XAI_DEFAULT_MODEL_REF } from "./onboard-auth.models.js";

const resolveAuthAgentDir = (agentDir?: string) => agentDir ?? resolveBotAgentDir();

export type ApiKeyStorageOptions = {
  secretInputMode?: SecretInputMode;
};

/**
 * Discover sibling agent dirs under the same `agents/` parent directory.
 * Given `<root>/agents/<id>/agent`, returns all `<root>/agents/* /agent` directories.
 */
function discoverSiblingAgentDirs(agentDir: string): string[] {
  // agentDir is typically `<root>/agents/<id>/agent`
  const agentParent = path.dirname(agentDir); // <root>/agents/<id>
  const agentsRoot = path.dirname(agentParent); // <root>/agents
  const agentsBasename = path.basename(agentsRoot);
  if (agentsBasename !== "agents") {
    return [agentDir];
  }
  try {
    const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    const siblings: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidateDir = path.join(agentsRoot, entry.name, "agent");
      try {
        fs.accessSync(candidateDir, fs.constants.F_OK);
        siblings.push(candidateDir);
      } catch {
        // skip non-existent agent subdirs
      }
    }
    return siblings.length > 0 ? siblings : [agentDir];
  } catch {
    return [agentDir];
  }
}

function isSecretRef(value: SecretInput): value is SecretRef {
  return typeof value === "object" && value !== null && "source" in value && "id" in value;
}

function resolveKeyAndRef(input: SecretInput): { key?: string; keyRef?: SecretRef | string } {
  if (isSecretRef(input)) {
    return { keyRef: input };
  }
  return { key: input };
}

export async function writeOAuthCredentials(
  provider: string,
  creds: OAuthCredentials,
  agentDir?: string,
  options?: { syncSiblingAgents?: boolean },
): Promise<string> {
  const email =
    typeof creds.email === "string" && creds.email.trim() ? creds.email.trim() : "default";
  const profileId = `${provider}:${email}`;
  const resolvedDir = resolveAuthAgentDir(agentDir);
  const dirs = options?.syncSiblingAgents ? discoverSiblingAgentDirs(resolvedDir) : [resolvedDir];
  for (const dir of dirs) {
    upsertAuthProfile({
      profileId,
      credential: {
        type: "oauth",
        provider,
        ...creds,
      },
      agentDir: dir,
    });
  }
  return profileId;
}

export async function setOpenaiApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "openai:default",
    credential: { type: "api_key", provider: "openai", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setAnthropicApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "anthropic:default",
    credential: {
      type: "api_key",
      provider: "anthropic",
      ...resolveKeyAndRef(input),
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setGeminiApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "google:default",
    credential: {
      type: "api_key",
      provider: "google",
      ...resolveKeyAndRef(input),
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMinimaxApiKey(
  input: SecretInput,
  agentDir?: string,
  profileId: string = "minimax:default",
  _options?: ApiKeyStorageOptions,
) {
  const provider = profileId.split(":")[0] ?? "minimax";
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId,
    credential: {
      type: "api_key",
      provider,
      ...resolveKeyAndRef(input),
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMoonshotApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "moonshot:default",
    credential: {
      type: "api_key",
      provider: "moonshot",
      ...resolveKeyAndRef(input),
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setKimiCodingApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "kimi-coding:default",
    credential: {
      type: "api_key",
      provider: "kimi-coding",
      ...resolveKeyAndRef(input),
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setSyntheticApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "synthetic:default",
    credential: {
      type: "api_key",
      provider: "synthetic",
      ...resolveKeyAndRef(input),
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setVeniceApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "venice:default",
    credential: {
      type: "api_key",
      provider: "venice",
      ...resolveKeyAndRef(input),
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export const KILOCODE_DEFAULT_MODEL_REF = "kilocode/claude-opus-4-6";
export const MISTRAL_DEFAULT_MODEL_REF = "mistral/mistral-large-latest";
export const ZAI_DEFAULT_MODEL_REF = "zai/glm-5";
export const XIAOMI_DEFAULT_MODEL_REF = "xiaomi/mimo-v2-flash";
export const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
export const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";
export const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";
export const LITELLM_DEFAULT_MODEL_REF = "litellm/claude-opus-4-6";
export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";

export async function setZaiApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "zai:default",
    credential: { type: "api_key", provider: "zai", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setXiaomiApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "xiaomi:default",
    credential: { type: "api_key", provider: "xiaomi", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setOpenrouterApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  if (isSecretRef(input)) {
    upsertAuthProfile({
      profileId: "openrouter:default",
      credential: { type: "api_key", provider: "openrouter", keyRef: input },
      agentDir: resolveAuthAgentDir(agentDir),
    });
    return;
  }
  // Never persist the literal "undefined" (e.g. when prompt returns undefined and caller used String(key)).
  const safeKey = input === "undefined" ? "" : input;
  upsertAuthProfile({
    profileId: "openrouter:default",
    credential: { type: "api_key", provider: "openrouter", key: safeKey },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setCloudflareAiGatewayConfig(
  accountId: string,
  gatewayId: string,
  apiKey: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  const normalizedAccountId = accountId.trim();
  const normalizedGatewayId = gatewayId.trim();
  const metadata = { accountId: normalizedAccountId, gatewayId: normalizedGatewayId };
  if (isSecretRef(apiKey)) {
    upsertAuthProfile({
      profileId: "cloudflare-ai-gateway:default",
      credential: { type: "api_key", provider: "cloudflare-ai-gateway", keyRef: apiKey, metadata },
      agentDir: resolveAuthAgentDir(agentDir),
    });
    return;
  }
  upsertAuthProfile({
    profileId: "cloudflare-ai-gateway:default",
    credential: {
      type: "api_key",
      provider: "cloudflare-ai-gateway",
      key: apiKey.trim(),
      metadata,
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setLitellmApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "litellm:default",
    credential: { type: "api_key", provider: "litellm", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setVercelAiGatewayApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "vercel-ai-gateway:default",
    credential: { type: "api_key", provider: "vercel-ai-gateway", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setOpencodeZenApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "opencode:default",
    credential: { type: "api_key", provider: "opencode", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setTogetherApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "together:default",
    credential: { type: "api_key", provider: "together", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setHuggingfaceApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "huggingface:default",
    credential: { type: "api_key", provider: "huggingface", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export function setQianfanApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "qianfan:default",
    credential: { type: "api_key", provider: "qianfan", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setByteplusApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "byteplus:default",
    credential: { type: "api_key", provider: "byteplus", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setKilocodeApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "kilocode:default",
    credential: { type: "api_key", provider: "kilocode", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMistralApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "mistral:default",
    credential: { type: "api_key", provider: "mistral", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setVolcengineApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "volcengine:default",
    credential: { type: "api_key", provider: "volcengine", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export function setXaiApiKey(
  input: SecretInput,
  agentDir?: string,
  _options?: ApiKeyStorageOptions,
) {
  upsertAuthProfile({
    profileId: "xai:default",
    credential: { type: "api_key", provider: "xai", ...resolveKeyAndRef(input) },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

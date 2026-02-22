import fs from "node:fs";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { resolveStateDir } from "../config/paths.js";
import { isSecretRef, type SecretInput, type SecretRef } from "../config/types.secrets.js";
import { KILOCODE_DEFAULT_MODEL_REF } from "../providers/kilocode-shared.js";
import { PROVIDER_ENV_VARS } from "../secrets/provider-env-vars.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
export { CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF } from "../agents/cloudflare-ai-gateway.js";
export { MISTRAL_DEFAULT_MODEL_REF, XAI_DEFAULT_MODEL_REF } from "./onboard-auth.models.js";
export { KILOCODE_DEFAULT_MODEL_REF };

const resolveAuthAgentDir = (agentDir?: string) => agentDir ?? resolveOpenClawAgentDir();

const ENV_REF_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
function buildEnvSecretRef(id: string): SecretRef {
  return { source: "env", id };
}

function parseEnvSecretRef(value: string): SecretRef | null {
  const match = ENV_REF_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return buildEnvSecretRef(match[1]);
}

function inferProviderEnvSecretRef(provider: string, value: string): SecretRef | null {
  const envVars = PROVIDER_ENV_VARS[provider];
  if (!envVars || value.length === 0) {
    return null;
  }
  for (const envVar of envVars) {
    const envValue = normalizeSecretInput(process.env[envVar] ?? "");
    if (envValue && envValue === value) {
      return buildEnvSecretRef(envVar);
    }
  }
  return null;
}

function resolveApiKeySecretInput(provider: string, input: SecretInput): SecretInput {
  if (isSecretRef(input)) {
    return input;
  }
  const normalized = normalizeSecretInput(input);
  const inlineEnvRef = parseEnvSecretRef(normalized);
  if (inlineEnvRef) {
    return inlineEnvRef;
  }
  const inferredEnvRef = inferProviderEnvSecretRef(provider, normalized);
  if (inferredEnvRef) {
    return inferredEnvRef;
  }
  return normalized;
}

function buildApiKeyCredential(
  provider: string,
  input: SecretInput,
  metadata?: Record<string, string>,
): {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;
  metadata?: Record<string, string>;
} {
  const secretInput = resolveApiKeySecretInput(provider, input);
  if (typeof secretInput === "string") {
    return {
      type: "api_key",
      provider,
      key: secretInput,
      ...(metadata ? { metadata } : {}),
    };
  }
  return {
    type: "api_key",
    provider,
    keyRef: secretInput,
    ...(metadata ? { metadata } : {}),
  };
}

export type WriteOAuthCredentialsOptions = {
  syncSiblingAgents?: boolean;
};

/** Resolve real path, returning null if the target doesn't exist. */
function safeRealpathSync(dir: string): string | null {
  try {
    return fs.realpathSync(path.resolve(dir));
  } catch {
    return null;
  }
}

function resolveSiblingAgentDirs(primaryAgentDir: string): string[] {
  const normalized = path.resolve(primaryAgentDir);

  // Derive agentsRoot from primaryAgentDir when it matches the standard
  // layout (.../agents/<name>/agent). Falls back to global state dir.
  const parentOfAgent = path.dirname(normalized);
  const candidateAgentsRoot = path.dirname(parentOfAgent);
  const looksLikeStandardLayout =
    path.basename(normalized) === "agent" && path.basename(candidateAgentsRoot) === "agents";

  const agentsRoot = looksLikeStandardLayout
    ? candidateAgentsRoot
    : path.join(resolveStateDir(), "agents");

  const entries = (() => {
    try {
      return fs.readdirSync(agentsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  // Include both directories and symlinks-to-directories.
  const discovered = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(agentsRoot, entry.name, "agent"));

  // Deduplicate via realpath to handle symlinks and path normalization.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of [normalized, ...discovered]) {
    const real = safeRealpathSync(dir);
    if (real && !seen.has(real)) {
      seen.add(real);
      result.push(real);
    }
  }
  return result;
}

export async function writeOAuthCredentials(
  provider: string,
  creds: OAuthCredentials,
  agentDir?: string,
  options?: WriteOAuthCredentialsOptions,
): Promise<string> {
  const email =
    typeof creds.email === "string" && creds.email.trim() ? creds.email.trim() : "default";
  const profileId = `${provider}:${email}`;
  const resolvedAgentDir = path.resolve(resolveAuthAgentDir(agentDir));
  const targetAgentDirs = options?.syncSiblingAgents
    ? resolveSiblingAgentDirs(resolvedAgentDir)
    : [resolvedAgentDir];

  const credential = {
    type: "oauth" as const,
    provider,
    ...creds,
  };

  // Primary write must succeed — let it throw on failure.
  upsertAuthProfile({
    profileId,
    credential,
    agentDir: resolvedAgentDir,
  });

  // Sibling sync is best-effort — log and ignore individual failures.
  if (options?.syncSiblingAgents) {
    const primaryReal = safeRealpathSync(resolvedAgentDir);
    for (const targetAgentDir of targetAgentDirs) {
      const targetReal = safeRealpathSync(targetAgentDir);
      if (targetReal && primaryReal && targetReal === primaryReal) {
        continue;
      }
      try {
        upsertAuthProfile({
          profileId,
          credential,
          agentDir: targetAgentDir,
        });
      } catch {
        // Best-effort: sibling sync failure must not block primary onboarding.
      }
    }
  }
  return profileId;
}

export async function setAnthropicApiKey(key: SecretInput, agentDir?: string) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "anthropic:default",
    credential: buildApiKeyCredential("anthropic", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setGeminiApiKey(key: SecretInput, agentDir?: string) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "google:default",
    credential: buildApiKeyCredential("google", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMinimaxApiKey(
  key: SecretInput,
  agentDir?: string,
  profileId: string = "minimax:default",
) {
  const provider = profileId.split(":")[0] ?? "minimax";
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId,
    credential: buildApiKeyCredential(provider, key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMoonshotApiKey(key: SecretInput, agentDir?: string) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "moonshot:default",
    credential: buildApiKeyCredential("moonshot", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setKimiCodingApiKey(key: SecretInput, agentDir?: string) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "kimi-coding:default",
    credential: buildApiKeyCredential("kimi-coding", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setSyntheticApiKey(key: SecretInput, agentDir?: string) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "synthetic:default",
    credential: buildApiKeyCredential("synthetic", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setVeniceApiKey(key: SecretInput, agentDir?: string) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "venice:default",
    credential: buildApiKeyCredential("venice", key),
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

export async function setZaiApiKey(key: SecretInput, agentDir?: string) {
  // Write to resolved agent dir so gateway finds credentials on startup.
  upsertAuthProfile({
    profileId: "zai:default",
    credential: buildApiKeyCredential("zai", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setXiaomiApiKey(key: SecretInput, agentDir?: string) {
  upsertAuthProfile({
    profileId: "xiaomi:default",
    credential: buildApiKeyCredential("xiaomi", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setOpenrouterApiKey(key: SecretInput, agentDir?: string) {
  // Never persist the literal "undefined" (e.g. when prompt returns undefined and caller used String(key)).
  const safeKey = typeof key === "string" && key === "undefined" ? "" : key;
  upsertAuthProfile({
    profileId: "openrouter:default",
    credential: buildApiKeyCredential("openrouter", safeKey),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setCloudflareAiGatewayConfig(
  accountId: string,
  gatewayId: string,
  apiKey: SecretInput,
  agentDir?: string,
) {
  const normalizedAccountId = accountId.trim();
  const normalizedGatewayId = gatewayId.trim();
  upsertAuthProfile({
    profileId: "cloudflare-ai-gateway:default",
    credential: buildApiKeyCredential("cloudflare-ai-gateway", apiKey, {
      accountId: normalizedAccountId,
      gatewayId: normalizedGatewayId,
    }),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setLitellmApiKey(key: SecretInput, agentDir?: string) {
  upsertAuthProfile({
    profileId: "litellm:default",
    credential: buildApiKeyCredential("litellm", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setVercelAiGatewayApiKey(key: SecretInput, agentDir?: string) {
  upsertAuthProfile({
    profileId: "vercel-ai-gateway:default",
    credential: buildApiKeyCredential("vercel-ai-gateway", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setOpencodeZenApiKey(key: SecretInput, agentDir?: string) {
  upsertAuthProfile({
    profileId: "opencode:default",
    credential: buildApiKeyCredential("opencode", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setTogetherApiKey(key: SecretInput, agentDir?: string) {
  upsertAuthProfile({
    profileId: "together:default",
    credential: buildApiKeyCredential("together", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setHuggingfaceApiKey(key: SecretInput, agentDir?: string) {
  upsertAuthProfile({
    profileId: "huggingface:default",
    credential: buildApiKeyCredential("huggingface", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export function setQianfanApiKey(key: SecretInput, agentDir?: string) {
  upsertAuthProfile({
    profileId: "qianfan:default",
    credential: buildApiKeyCredential("qianfan", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export function setXaiApiKey(key: SecretInput, agentDir?: string) {
  upsertAuthProfile({
    profileId: "xai:default",
    credential: buildApiKeyCredential("xai", key),
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setMistralApiKey(key: string, agentDir?: string) {
  upsertAuthProfile({
    profileId: "mistral:default",
    credential: {
      type: "api_key",
      provider: "mistral",
      key,
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

export async function setKilocodeApiKey(key: string, agentDir?: string) {
  upsertAuthProfile({
    profileId: "kilocode:default",
    credential: {
      type: "api_key",
      provider: "kilocode",
      key,
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}

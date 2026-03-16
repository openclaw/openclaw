import crypto from "node:crypto";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral";

function fingerprintSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

function readHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== needle || typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  authSource: string;
  authFingerprint: string;
}> {
  const remote = params.options.remote;
  const remoteApiKey = resolveMemorySecretInputString({
    value: remote?.apiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  });
  const remoteBaseUrl = remote?.baseUrl?.trim();
  const providerConfig = params.options.config.models?.providers?.[params.provider];
  const resolvedAuth = remoteApiKey
    ? {
        apiKey: remoteApiKey,
        source: "agents.*.memorySearch.remote.apiKey",
        mode: "api-key" as const,
      }
    : await resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.options.config,
        agentDir: params.options.agentDir,
      });
  const apiKey = requireApiKey(resolvedAuth, params.provider);
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || params.defaultBaseUrl;
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  const providerAuthorizationOverride = readHeaderValue(providerConfig?.headers, "Authorization");
  const remoteAuthorizationOverride = readHeaderValue(remote?.headers, "Authorization");
  const effectiveAuthorization = readHeaderValue(headers, "Authorization");
  const hasAuthorizationOverride = Boolean(
    providerAuthorizationOverride || remoteAuthorizationOverride,
  );
  return {
    baseUrl,
    headers,
    ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
    authSource: remoteAuthorizationOverride
      ? "agents.*.memorySearch.remote.headers.Authorization"
      : providerAuthorizationOverride
        ? `models.providers.${params.provider}.headers.Authorization`
        : resolvedAuth.source,
    authFingerprint:
      hasAuthorizationOverride && effectiveAuthorization
        ? fingerprintSecret(effectiveAuthorization)
        : fingerprintSecret(apiKey),
  };
}

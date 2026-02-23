import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";

export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral";

export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string>; ssrfPolicy?: SsrFPolicy }> {
  const remote = params.options.remote;
  const remoteApiKey = remote?.apiKey?.trim();
  const remoteBaseUrl = remote?.baseUrl?.trim();
  const providerConfig = params.options.config.models?.providers?.[params.provider];
  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          provider: params.provider,
          cfg: params.options.config,
          agentDir: params.options.agentDir,
        }),
        params.provider,
      );
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || params.defaultBaseUrl;
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}

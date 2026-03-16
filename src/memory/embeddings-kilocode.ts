import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  KILOCODE_BASE_URL,
  KILOCODE_ORG_ID_HEADER,
  resolveKilocodeOrgId,
} from "../providers/kilocode-shared.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export type KilocodeEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};

export const DEFAULT_KILOCODE_EMBEDDING_MODEL = "mistralai/mistral-embed";

const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_VALUE = "openclaw-embedding";

export function normalizeKilocodeModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_KILOCODE_EMBEDDING_MODEL,
    prefixes: ["kilocode/"],
  });
}

export async function createKilocodeEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: KilocodeEmbeddingClient }> {
  const client = await resolveKilocodeEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      body: { model: client.model, input },
      errorPrefix: "kilocode embeddings failed",
    });
  };

  return {
    provider: {
      id: "kilocode",
      model: client.model,
      embedQuery: async (text) => {
        const [vec] = await embed([text]);
        return vec ?? [];
      },
      embedBatch: embed,
    },
    client,
  };
}

export async function resolveKilocodeEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<KilocodeEmbeddingClient> {
  const remote = options.remote;
  const remoteApiKey = resolveMemorySecretInputString({
    value: remote?.apiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  });
  const remoteBaseUrl = remote?.baseUrl?.trim();

  // Resolve API key: explicit remote override → standard kilocode auth chain
  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          provider: "kilocode",
          cfg: options.config,
          agentDir: options.agentDir,
        }),
        "kilocode",
      );

  const providerConfig = options.config.models?.providers?.kilocode;
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || KILOCODE_BASE_URL;
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  // Resolve org ID priority (highest → lowest):
  //   1. remote.organizationId (dedicated field)
  //   2. remote.headers["X-KILOCODE-ORGANIZATIONID"] (explicit header override)
  //   3. providerConfig.organizationId / providerConfig.headers["X-KILOCODE-ORGANIZATIONID"]
  //   4. KILOCODE_ORG_ID env var
  // Including remote.headers in the chain prevents the env var from silently overwriting
  // an org ID that the caller set via remote.headers.
  const remoteHeaderOrgId =
    typeof remote?.headers?.[KILOCODE_ORG_ID_HEADER] === "string"
      ? remote.headers[KILOCODE_ORG_ID_HEADER].trim()
      : undefined;
  const remoteOrgId = remote?.organizationId?.trim() || remoteHeaderOrgId;
  const orgId = remoteOrgId || resolveKilocodeOrgId(providerConfig);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
    [KILOCODE_FEATURE_HEADER]: KILOCODE_FEATURE_VALUE,
    ...(orgId ? { [KILOCODE_ORG_ID_HEADER]: orgId } : {}),
  };

  const model = normalizeKilocodeModel(options.model);
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl), model };
}

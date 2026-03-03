import { resolveRemoteEmbeddingBearerClient, } from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
export function createRemoteEmbeddingProvider(params) {
    const { client } = params;
    const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;
    const embed = async (input) => {
        if (input.length === 0) {
            return [];
        }
        return await fetchRemoteEmbeddingVectors({
            url,
            headers: client.headers,
            ssrfPolicy: client.ssrfPolicy,
            body: { model: client.model, input },
            errorPrefix: params.errorPrefix,
        });
    };
    return {
        id: params.id,
        model: client.model,
        ...(typeof params.maxInputTokens === "number" ? { maxInputTokens: params.maxInputTokens } : {}),
        embedQuery: async (text) => {
            const [vec] = await embed([text]);
            return vec ?? [];
        },
        embedBatch: embed,
    };
}
export async function resolveRemoteEmbeddingClient(params) {
    const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
        provider: params.provider,
        options: params.options,
        defaultBaseUrl: params.defaultBaseUrl,
    });
    const model = params.normalizeModel(params.options.model);
    return { baseUrl, headers, ssrfPolicy, model };
}

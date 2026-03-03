import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const VOYAGE_MAX_INPUT_TOKENS = {
    "voyage-3": 32000,
    "voyage-3-lite": 16000,
    "voyage-code-3": 32000,
};
export function normalizeVoyageModel(model) {
    const trimmed = model.trim();
    if (!trimmed) {
        return DEFAULT_VOYAGE_EMBEDDING_MODEL;
    }
    if (trimmed.startsWith("voyage/")) {
        return trimmed.slice("voyage/".length);
    }
    return trimmed;
}
export async function createVoyageEmbeddingProvider(options) {
    const client = await resolveVoyageEmbeddingClient(options);
    const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;
    const embed = async (input, input_type) => {
        if (input.length === 0) {
            return [];
        }
        const body = {
            model: client.model,
            input,
        };
        if (input_type) {
            body.input_type = input_type;
        }
        return await fetchRemoteEmbeddingVectors({
            url,
            headers: client.headers,
            ssrfPolicy: client.ssrfPolicy,
            body,
            errorPrefix: "voyage embeddings failed",
        });
    };
    return {
        provider: {
            id: "voyage",
            model: client.model,
            maxInputTokens: VOYAGE_MAX_INPUT_TOKENS[client.model],
            embedQuery: async (text) => {
                const [vec] = await embed([text], "query");
                return vec ?? [];
            },
            embedBatch: async (texts) => embed(texts, "document"),
        },
        client,
    };
}
export async function resolveVoyageEmbeddingClient(options) {
    const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
        provider: "voyage",
        options,
        defaultBaseUrl: DEFAULT_VOYAGE_BASE_URL,
    });
    const model = normalizeVoyageModel(options.model);
    return { baseUrl, headers, ssrfPolicy, model };
}

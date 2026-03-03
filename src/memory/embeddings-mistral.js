import { createRemoteEmbeddingProvider, resolveRemoteEmbeddingClient, } from "./embeddings-remote-provider.js";
export const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
export function normalizeMistralModel(model) {
    const trimmed = model.trim();
    if (!trimmed) {
        return DEFAULT_MISTRAL_EMBEDDING_MODEL;
    }
    if (trimmed.startsWith("mistral/")) {
        return trimmed.slice("mistral/".length);
    }
    return trimmed;
}
export async function createMistralEmbeddingProvider(options) {
    const client = await resolveMistralEmbeddingClient(options);
    return {
        provider: createRemoteEmbeddingProvider({
            id: "mistral",
            client,
            errorPrefix: "mistral embeddings failed",
        }),
        client,
    };
}
export async function resolveMistralEmbeddingClient(options) {
    return await resolveRemoteEmbeddingClient({
        provider: "mistral",
        options,
        defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
        normalizeModel: normalizeMistralModel,
    });
}

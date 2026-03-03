import { createRemoteEmbeddingProvider, resolveRemoteEmbeddingClient, } from "./embeddings-remote-provider.js";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MAX_INPUT_TOKENS = {
    "text-embedding-3-small": 8192,
    "text-embedding-3-large": 8192,
    "text-embedding-ada-002": 8191,
};
export function normalizeOpenAiModel(model) {
    const trimmed = model.trim();
    if (!trimmed) {
        return DEFAULT_OPENAI_EMBEDDING_MODEL;
    }
    if (trimmed.startsWith("openai/")) {
        return trimmed.slice("openai/".length);
    }
    return trimmed;
}
export async function createOpenAiEmbeddingProvider(options) {
    const client = await resolveOpenAiEmbeddingClient(options);
    return {
        provider: createRemoteEmbeddingProvider({
            id: "openai",
            client,
            errorPrefix: "openai embeddings failed",
            maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model],
        }),
        client,
    };
}
export async function resolveOpenAiEmbeddingClient(options) {
    return await resolveRemoteEmbeddingClient({
        provider: "openai",
        options,
        defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
        normalizeModel: normalizeOpenAiModel,
    });
}

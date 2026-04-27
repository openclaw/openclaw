const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;
const DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS = 2048;
export function resolveEmbeddingMaxInputTokens(provider) {
    if (typeof provider.maxInputTokens === "number") {
        return provider.maxInputTokens;
    }
    if (provider.id === "local") {
        return DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS;
    }
    return DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;
}

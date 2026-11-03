/** Native memory wire codecs shared by direct providers and credential-scoped routers.
 * These helpers own no credentials, URLs, retries or provider selection.
 */
export {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  GEMINI_MAX_INPUT_TOKENS,
  buildGeminiEmbeddingRequest,
  isGeminiEmbedding2Model,
  isValidGeminiEmbeddingValues,
  normalizeGeminiModel,
  readGeminiBatchEmbeddings,
  readGeminiEmbeddingValues,
  resolveGeminiOutputDimensionality,
  sanitizeGeminiEmbedding,
  type GeminiEmbeddingRequest,
} from "./embedding-native-google.js";
export {
  buildBedrockEmbeddingBody,
  buildCohereEmbeddingBody,
  readBedrockSingleEmbedding,
  readCohereEmbeddingBatch,
  resolveBedrockEmbeddingSpec,
  stripInferenceProfilePrefix,
  type BedrockEmbeddingFamily,
  type BedrockEmbeddingSpec,
} from "./embedding-native-bedrock.js";

/** Native Voyage text embeddings use role-specific query/document hints. */
export function voyageEmbeddingRequestFields(kind: "query" | "document", dimensions?: number) {
  return {
    input_type: kind,
    ...(dimensions === undefined ? {} : { output_dimension: dimensions }),
  };
}

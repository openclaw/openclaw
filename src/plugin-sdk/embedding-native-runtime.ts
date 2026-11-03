/** Native memory wire codecs shared by direct providers and credential-scoped routers.
 * These helpers own no credentials, URLs, retries or provider selection.
 */
export * from "./embedding-native-google.js";
export * from "./embedding-native-bedrock.js";

/** Native Voyage text embeddings use role-specific query/document hints. */
export function voyageEmbeddingRequestFields(kind: "query" | "document", dimensions?: number) {
  return {
    input_type: kind,
    ...(dimensions === undefined ? {} : { output_dimension: dimensions }),
  };
}

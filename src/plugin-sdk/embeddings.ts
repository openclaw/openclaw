// Public SDK surface for embedding providers.
// Re-exports the embedding provider API from a stable path so that plugins
// do not need to reach into memory-core internals.

export * from "../memory-host-sdk/engine-embeddings.js";

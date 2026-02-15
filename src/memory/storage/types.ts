export type StoredChunk = {
  id: string;
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  hash: string;
  model: string;
  text: string;
  embedding: number[];
  updatedAt: number;
};

export type SearchResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

export type SearchParams = {
  queryVec?: number[];
  queryText?: string;
  limit: number;
  providerModel: string; // for filtering chunks by model
  sources: string[];
  snippetMaxChars: number;
  minScore?: number;
  hybridWeights?: {
    vector: number;
    text: number;
  };
};

export type EmbeddingCacheKey = {
  provider: string;
  model: string;
  hash: string;
  providerKey?: string;
};

export interface MemoryStore {
  // Initialization
  init(): Promise<void>;
  close(): Promise<void>;

  // Metadata
  getMeta(key: string): Promise<any | null>;
  setMeta(key: string, value: any): Promise<void>;

  // File Tracking
  getFileHash(path: string, source: string): Promise<string | null>;
  listFilePaths(source: string): Promise<string[]>;
  setFile(path: string, source: string, hash: string, mtime: number, size: number): Promise<void>;

  // Removes file record AND its chunks
  removeFile(path: string, source: string): Promise<void>;

  // Chunk Management
  // Inserts chunks. Implementation should handle transaction/batching.
  insertChunks(chunks: StoredChunk[]): Promise<void>;

  // Search
  // Should handle vector search, keyword search, or hybrid depending on capabilities and params
  search(params: SearchParams): Promise<SearchResult[]>;

  // Embedding Cache
  getCachedEmbedding(key: EmbeddingCacheKey): Promise<number[] | null>;
  setCachedEmbedding(key: EmbeddingCacheKey, embedding: number[]): Promise<void>;

  // Maintenance
  // e.g. optimize, vacuum, cleanup
  maintenance?(): Promise<void>;

  getStats(sources: string[]): Promise<{
    files: number;
    chunks: number;
    sourceCounts: Array<{ source: string; files: number; chunks: number }>;
    cacheEntries: number;
  }>;
}

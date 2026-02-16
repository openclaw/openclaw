/**
 * Azure Table Storage memory provider for serverless OpenClaw deployments.
 *
 * Stores memory chunks, file metadata, and embedding cache in Azure Table
 * Storage. Provides keyword-based search over stored chunks (vector search
 * requires an external service such as Azure AI Search and is reported as
 * unavailable by this provider).
 *
 * Environment variable:
 *   AZURE_STORAGE_CONNECTION_STRING – connection string for the storage account.
 */

import { TableClient, TableServiceClient } from "@azure/data-tables";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";

// ---------------------------------------------------------------------------
// Table names (must match Bicep template)
// ---------------------------------------------------------------------------
const TABLE_CHUNKS = "memorychunks";
const TABLE_FILES = "memoryfiles";
const TABLE_META = "memorymeta";
const TABLE_EMBEDDING_CACHE = "embeddingcache";

// ---------------------------------------------------------------------------
// Entity shapes
// ---------------------------------------------------------------------------
interface ChunkEntity {
  partitionKey: string; // agentId
  rowKey: string; // chunk id
  path: string;
  source: MemorySource;
  startLine: number;
  endLine: number;
  hash: string;
  model: string;
  text: string;
  embedding: string; // JSON-encoded number[]
  updatedAt: string;
}

interface FileEntity {
  partitionKey: string; // agentId
  rowKey: string; // path (url-encoded)
  source: MemorySource;
  hash: string;
  mtime: number;
  size: number;
}

interface MetaEntity {
  partitionKey: string; // agentId
  rowKey: string; // key
  value: string;
}

interface EmbeddingCacheEntity {
  partitionKey: string; // agentId
  rowKey: string; // `${provider}|${model}|${hash}`
  provider: string;
  model: string;
  providerKey: string;
  hash: string;
  embedding: string; // JSON-encoded number[]
  dims: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function encodeRowKey(raw: string): string {
  // Azure Table row keys cannot contain / \ # ?
  return encodeURIComponent(raw).replace(/%/g, "$");
}

function connectionString(): string {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING environment variable is required for AzureTableMemoryProvider",
    );
  }
  return cs;
}

function scoreChunk(text: string, queryTokens: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const t of queryTokens) {
    if (lower.includes(t)) hits++;
  }
  return queryTokens.length > 0 ? hits / queryTokens.length : 0;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AzureTableMemoryProvider implements MemorySearchManager {
  private chunksClient: TableClient;
  private filesClient: TableClient;
  private metaClient: TableClient;
  private cacheClient: TableClient;
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
    const cs = connectionString();
    this.chunksClient = TableClient.fromConnectionString(cs, TABLE_CHUNKS);
    this.filesClient = TableClient.fromConnectionString(cs, TABLE_FILES);
    this.metaClient = TableClient.fromConnectionString(cs, TABLE_META);
    this.cacheClient = TableClient.fromConnectionString(cs, TABLE_EMBEDDING_CACHE);
  }

  /** Ensure all tables exist (idempotent). */
  async ensureTables(): Promise<void> {
    const cs = connectionString();
    const svc = TableServiceClient.fromConnectionString(cs);
    await Promise.all([
      svc.createTable(TABLE_CHUNKS).catch(() => {}),
      svc.createTable(TABLE_FILES).catch(() => {}),
      svc.createTable(TABLE_META).catch(() => {}),
      svc.createTable(TABLE_EMBEDDING_CACHE).catch(() => {}),
    ]);
  }

  // -------------------------------------------------------------------------
  // MemorySearchManager – search
  // -------------------------------------------------------------------------
  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const maxResults = opts?.maxResults ?? 10;
    const minScore = opts?.minScore ?? 0.01;
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];

    const results: MemorySearchResult[] = [];

    const iter = this.chunksClient.listEntities<ChunkEntity>({
      queryOptions: { filter: `PartitionKey eq '${this.agentId}'` },
    });

    for await (const entity of iter) {
      const score = scoreChunk(entity.text ?? "", tokens);
      if (score >= minScore) {
        results.push({
          path: entity.path,
          startLine: entity.startLine ?? 0,
          endLine: entity.endLine ?? 0,
          score,
          snippet: (entity.text ?? "").slice(0, 500),
          source: (entity.source as MemorySource) ?? "memory",
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  // -------------------------------------------------------------------------
  // MemorySearchManager – readFile
  // -------------------------------------------------------------------------
  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rowKey = encodeRowKey(params.relPath);
    const chunks: string[] = [];

    const iter = this.chunksClient.listEntities<ChunkEntity>({
      queryOptions: {
        filter: `PartitionKey eq '${this.agentId}' and path eq '${params.relPath}'`,
      },
    });

    for await (const entity of iter) {
      chunks.push(entity.text ?? "");
    }

    const fullText = chunks.join("\n");
    if (params.from !== undefined || params.lines !== undefined) {
      const allLines = fullText.split("\n");
      const start = params.from ?? 0;
      const count = params.lines ?? allLines.length;
      return { text: allLines.slice(start, start + count).join("\n"), path: params.relPath };
    }
    return { text: fullText, path: params.relPath };
  }

  // -------------------------------------------------------------------------
  // MemorySearchManager – status
  // -------------------------------------------------------------------------
  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "azure-table-storage",
      vector: { enabled: false, available: false },
      fts: { enabled: false, available: false },
      cache: { enabled: true },
      custom: { agentId: this.agentId },
    };
  }

  // -------------------------------------------------------------------------
  // MemorySearchManager – sync
  // -------------------------------------------------------------------------
  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    // In serverless mode, sync is a no-op. Chunks are upserted directly via
    // upsertChunk() / upsertFile() during ingestion pipelines.
    params?.progress?.({ completed: 1, total: 1, label: "azure-table-sync" });
  }

  // -------------------------------------------------------------------------
  // MemorySearchManager – probes
  // -------------------------------------------------------------------------
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: false, error: "Embeddings are not computed by this provider" };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return false;
  }

  // -------------------------------------------------------------------------
  // MemorySearchManager – close
  // -------------------------------------------------------------------------
  async close(): Promise<void> {
    // No persistent connections to close for Azure Table Storage.
  }

  // -------------------------------------------------------------------------
  // Write helpers (used by ingestion / sync pipelines)
  // -------------------------------------------------------------------------

  async upsertChunk(chunk: {
    id: string;
    path: string;
    source: MemorySource;
    startLine: number;
    endLine: number;
    hash: string;
    model: string;
    text: string;
    embedding?: number[];
  }): Promise<void> {
    const entity: ChunkEntity = {
      partitionKey: this.agentId,
      rowKey: encodeRowKey(chunk.id),
      path: chunk.path,
      source: chunk.source,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      hash: chunk.hash,
      model: chunk.model,
      text: chunk.text,
      embedding: chunk.embedding ? JSON.stringify(chunk.embedding) : "[]",
      updatedAt: new Date().toISOString(),
    };
    await this.chunksClient.upsertEntity(entity, "Replace");
  }

  async upsertFile(file: {
    path: string;
    source: MemorySource;
    hash: string;
    mtime: number;
    size: number;
  }): Promise<void> {
    const entity: FileEntity = {
      partitionKey: this.agentId,
      rowKey: encodeRowKey(file.path),
      source: file.source,
      hash: file.hash,
      mtime: file.mtime,
      size: file.size,
    };
    await this.filesClient.upsertEntity(entity, "Replace");
  }

  async upsertMeta(key: string, value: string): Promise<void> {
    const entity: MetaEntity = {
      partitionKey: this.agentId,
      rowKey: encodeRowKey(key),
      value,
    };
    await this.metaClient.upsertEntity(entity, "Replace");
  }

  async getMeta(key: string): Promise<string | undefined> {
    try {
      const entity = await this.metaClient.getEntity<MetaEntity>(
        this.agentId,
        encodeRowKey(key),
      );
      return entity.value;
    } catch {
      return undefined;
    }
  }

  async upsertEmbeddingCache(entry: {
    provider: string;
    model: string;
    providerKey: string;
    hash: string;
    embedding: number[];
    dims: number;
  }): Promise<void> {
    const entity: EmbeddingCacheEntity = {
      partitionKey: this.agentId,
      rowKey: encodeRowKey(`${entry.provider}|${entry.model}|${entry.hash}`),
      provider: entry.provider,
      model: entry.model,
      providerKey: entry.providerKey,
      hash: entry.hash,
      embedding: JSON.stringify(entry.embedding),
      dims: entry.dims,
      updatedAt: new Date().toISOString(),
    };
    await this.cacheClient.upsertEntity(entity, "Replace");
  }

  async getEmbeddingCache(
    provider: string,
    model: string,
    hash: string,
  ): Promise<number[] | undefined> {
    try {
      const entity = await this.cacheClient.getEntity<EmbeddingCacheEntity>(
        this.agentId,
        encodeRowKey(`${provider}|${model}|${hash}`),
      );
      return JSON.parse(entity.embedding);
    } catch {
      return undefined;
    }
  }

  async deleteChunksByPath(path: string, source: MemorySource): Promise<void> {
    const iter = this.chunksClient.listEntities<ChunkEntity>({
      queryOptions: {
        filter: `PartitionKey eq '${this.agentId}' and path eq '${path}' and source eq '${source}'`,
      },
    });
    for await (const entity of iter) {
      await this.chunksClient.deleteEntity(entity.partitionKey, entity.rowKey);
    }
  }
}

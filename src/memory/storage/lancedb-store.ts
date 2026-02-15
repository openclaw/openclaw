import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MemoryStore,
  SearchParams,
  SearchResult,
  StoredChunk,
  EmbeddingCacheKey,
} from "./types.js";

export type LanceDBConfig = {
  dbPath: string;
  tableName?: string;
  cacheTableName?: string;
  filesTableName?: string;
};

export class LanceDBMemoryStore implements MemoryStore {
  private db!: lancedb.Connection;
  private table!: lancedb.Table;
  private cacheTable!: lancedb.Table;
  private filesTable!: lancedb.Table; // Using a separate table for files tracking

  private tableName: string;
  private cacheTableName: string;
  private filesTableName: string;

  constructor(private config: LanceDBConfig) {
    this.tableName = config.tableName ?? "chunks";
    this.cacheTableName = config.cacheTableName ?? "embedding_cache";
    this.filesTableName = config.filesTableName ?? "files_tracker";
  }

  async init(): Promise<void> {
    // Ensure directory exists
    try {
      await fs.mkdir(this.config.dbPath, { recursive: true });
    } catch {}

    this.db = await lancedb.connect(this.config.dbPath);

    // Initialize Files Table
    try {
      this.filesTable = await this.db.openTable(this.filesTableName);
    } catch {
      const dummy = [{ path: "_init_", source: "_init_", hash: "", mtime: 0, size: 0 }];
      this.filesTable = await this.db.createTable(this.filesTableName, dummy);
      await this.filesTable.delete("path = '_init_'");
    }

    // Initialize Cache Table
    try {
      this.cacheTable = await this.db.openTable(this.cacheTableName);
    } catch {
      // Cache table schema is fixed, embeddings are variable length but stored as List<Float>
      // LanceDB handles variable length lists if we don't enforce fixed size in schema
      const dummy = [
        {
          provider: "_init_",
          model: "_init_",
          hash: "_init_",
          providerKey: "",
          embedding: [0.0],
          dims: 1,
          updatedAt: 0,
        },
      ];
      this.cacheTable = await this.db.createTable(this.cacheTableName, dummy);
      await this.cacheTable.delete("provider = '_init_'");
    }

    // Initialize Chunks Table
    // We defer creation if it doesn't exist, because we need to know the vector dimension from the first insert
    try {
      this.table = await this.db.openTable(this.tableName);
    } catch {
      // Table doesn't exist. We'll create it on first insertChunks call.
    }
  }

  async close(): Promise<void> {
    // LanceDB connection doesn't strictly need closing in Node SDK
  }

  async getMeta(key: string): Promise<any | null> {
    try {
      const metaTable = await this.db.openTable("meta");
      const res = await metaTable.query().where(`key = '${key}'`).limit(1).toArray();
      if (res.length > 0) {
        return JSON.parse(res[0].value as string);
      }
    } catch {
      // Table might not exist
    }
    return null;
  }

  async setMeta(key: string, value: any): Promise<void> {
    let metaTable: lancedb.Table;
    try {
      metaTable = await this.db.openTable("meta");
    } catch {
      metaTable = await this.db.createTable("meta", [{ key: "_init_", value: "" }]);
      await metaTable.delete("key = '_init_'");
    }

    // Upsert logic: delete old, insert new
    await metaTable.delete(`key = '${key}'`);
    await metaTable.add([{ key, value: JSON.stringify(value) }]);
  }

  async getFileHash(path: string, source: string): Promise<string | null> {
    try {
      const res = await this.filesTable
        .query()
        .where(`path = '${path}' AND source = '${source}'`)
        .limit(1)
        .toArray();
      return res.length > 0 ? (res[0].hash as string) : null;
    } catch {
      return null;
    }
  }

  async listFilePaths(source: string): Promise<string[]> {
    try {
      const res = await this.filesTable
        .query()
        .where(`source = '${source}'`)
        .select(["path"])
        .toArray();
      return res.map((r) => r.path as string);
    } catch {
      return [];
    }
  }

  async setFile(
    path: string,
    source: string,
    hash: string,
    mtime: number,
    size: number,
  ): Promise<void> {
    // Upsert
    await this.filesTable.delete(`path = '${path}' AND source = '${source}'`);
    await this.filesTable.add([{ path, source, hash, mtime, size }]);
  }

  async removeFile(path: string, source: string): Promise<void> {
    await this.filesTable.delete(`path = '${path}' AND source = '${source}'`);
    // Also remove chunks
    await this.deleteChunksByPath(path, source);
  }

  private async deleteChunksByPath(path: string, source: string): Promise<void> {
    try {
      await this.table.delete(`path = '${path}' AND source = '${source}'`);
    } catch {}
  }

  async insertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    if (!this.table) {
      try {
        this.table = await this.db.openTable(this.tableName);
      } catch {
        // Create table with schema inferred from the first batch
        this.table = await this.db.createTable(this.tableName, chunks);
        return;
      }
    }

    await this.table.add(chunks);
  }

  async search(params: SearchParams): Promise<SearchResult[]> {
    const { queryVec, limit, sources } = params;

    // Vector Search
    if (queryVec && queryVec.length > 0) {
      let search = this.table.search(queryVec).limit(limit);

      if (sources.length > 0) {
        const sourceList = sources.map((s) => `'${s}'`).join(", ");
        search = search.where(`source IN (${sourceList})`);
      }

      const results = await search.toArray();

      return results.map((r) => ({
        id: r.id as string,
        path: r.path as string,
        startLine: r.startLine as number,
        endLine: r.endLine as number,
        // LanceDB returns _distance, convert to score approximation
        // For cosine distance (default), distance is between 0 and 2.
        // Score = 1 - distance/2 or similar.
        // For now assuming 1 - distance is close enough for ranking
        score: 1 - ((r._distance as number) || 0),
        snippet: r.text as string,
        source: r.source as string,
      }));
    }

    return [];
  }

  async getCachedEmbedding(key: EmbeddingCacheKey): Promise<number[] | null> {
    try {
      const res = await this.cacheTable
        .query()
        .where(`provider = '${key.provider}' AND model = '${key.model}' AND hash = '${key.hash}'`)
        .limit(1)
        .toArray();
      if (res.length > 0) {
        const raw = res[0].embedding;
        if (Array.isArray(raw)) return raw as number[];
        if (raw && typeof raw === "object") {
          // Handle Arrow Vector or Float32Array
          return Array.from(raw as Iterable<number>);
        }
        return null;
      }
      return null;
    } catch {
      return null;
    }
  }

  async setCachedEmbedding(key: EmbeddingCacheKey, embedding: number[]): Promise<void> {
    const where = `provider = '${key.provider}' AND model = '${key.model}' AND hash = '${key.hash}'`;
    await this.cacheTable.delete(where);

    await this.cacheTable.add([
      {
        provider: key.provider,
        model: key.model,
        hash: key.hash,
        providerKey: key.providerKey ?? "",
        embedding,
        dims: embedding.length,
        updatedAt: Date.now(),
      },
    ]);
  }

  async getStats(sources: string[]): Promise<{
    files: number;
    chunks: number;
    sourceCounts: Array<{ source: string; files: number; chunks: number }>;
    cacheEntries: number;
  }> {
    const filesCount = await this.filesTable.countRows();
    const chunksCount = await this.table.countRows();
    const cacheCount = await this.cacheTable.countRows();

    const sourceCounts: Array<{ source: string; files: number; chunks: number }> = [];

    for (const source of sources) {
      const fRows = await this.filesTable.query().where(`source = '${source}'`).toArray();
      const cRows = await this.table.query().where(`source = '${source}'`).toArray();
      sourceCounts.push({ source, files: fRows.length, chunks: cRows.length });
    }

    return {
      files: filesCount,
      chunks: chunksCount,
      sourceCounts,
      cacheEntries: cacheCount,
    };
  }
}

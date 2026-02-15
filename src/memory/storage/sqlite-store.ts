import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "../../utils.js";
import { buildFtsQuery, bm25RankToScore, mergeHybridResults } from "../hybrid.js";
import { searchVector, searchKeyword, listChunks } from "../manager-search.js";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { loadSqliteVecExtension } from "../sqlite-vec.js";
import { requireNodeSqlite } from "../sqlite.js";
import {
  MemoryStore,
  SearchParams,
  SearchResult,
  StoredChunk,
  EmbeddingCacheKey,
} from "./types.js";

const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";

export type SQLiteMemoryStoreConfig = {
  dbPath: string;
  vectorTable?: string;
  ftsTable?: string;
  embeddingCacheTable?: string;
  ftsEnabled?: boolean;
};

export class SQLiteMemoryStore implements MemoryStore {
  private db!: DatabaseSync;
  private vectorTable: string;
  private ftsTable: string;
  private embeddingCacheTable: string;
  private ftsEnabled: boolean;
  private ftsAvailable = false;
  private vectorReady = false;

  constructor(private config: SQLiteMemoryStoreConfig) {
    this.vectorTable = config.vectorTable ?? VECTOR_TABLE;
    this.ftsTable = config.ftsTable ?? FTS_TABLE;
    this.embeddingCacheTable = config.embeddingCacheTable ?? EMBEDDING_CACHE_TABLE;
    this.ftsEnabled = config.ftsEnabled ?? true;
  }

  async init(): Promise<void> {
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(this.config.dbPath);

    // Initialize schema
    const schemaResult = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: this.embeddingCacheTable,
      ftsTable: this.ftsTable,
      ftsEnabled: this.ftsEnabled,
    });
    this.ftsAvailable = schemaResult.ftsAvailable;

    // Load vector extension
    try {
      const result = await loadSqliteVecExtension({ db: this.db });
      this.vectorReady = result.ok;
      if (!result.ok) {
        console.warn("Failed to load sqlite-vec extension:", result.error);
      }
    } catch (err) {
      console.warn("Failed to load sqlite-vec extension:", err);
      this.vectorReady = false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async getMeta(key: string): Promise<any | null> {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  async setMeta(key: string, value: any): Promise<void> {
    const str = JSON.stringify(value);
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, str);
  }

  async getFileHash(path: string, source: string): Promise<string | null> {
    const row = this.db
      .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
      .get(path, source) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  async listFilePaths(source: string): Promise<string[]> {
    const rows = this.db.prepare(`SELECT path FROM files WHERE source = ?`).all(source) as Array<{
      path: string;
    }>;
    return rows.map((r) => r.path);
  }

  async setFile(
    path: string,
    source: string,
    hash: string,
    mtime: number,
    size: number,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(path, source, hash, mtime, size);
  }

  async removeFile(path: string, source: string): Promise<void> {
    this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(path, source);
    this.deleteChunksByPath(path, source);
  }

  async deleteChunksByPath(path: string, source: string): Promise<void> {
    try {
      this.db
        .prepare(
          `DELETE FROM ${this.vectorTable} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(path, source);
    } catch {}

    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(path, source);

    if (this.ftsEnabled && this.ftsAvailable) {
      try {
        // FTS table deletion might need model filtering if we were strict, but path/source is usually enough uniqueness or we delete all matching
        this.db
          .prepare(`DELETE FROM ${this.ftsTable} WHERE path = ? AND source = ?`)
          .run(path, source);
      } catch {}
    }
  }

  async insertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertVec = this.vectorReady
      ? this.db.prepare(`INSERT INTO ${this.vectorTable} (id, embedding) VALUES (?, ?)`)
      : null;

    const insertFts =
      this.ftsEnabled && this.ftsAvailable
        ? this.db.prepare(
            `INSERT INTO ${this.ftsTable} (id, path, source, start_line, end_line, text, model) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
        : null;

    const vectorToBlob = (embedding: number[]): Buffer =>
      Buffer.from(new Float32Array(embedding).buffer);

    // Transaction
    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const chunk of chunks) {
        const embeddingStr = JSON.stringify(chunk.embedding);
        insertChunk.run(
          chunk.id,
          chunk.path,
          chunk.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          chunk.model,
          chunk.text,
          embeddingStr,
          chunk.updatedAt,
        );

        if (insertVec) {
          insertVec.run(chunk.id, vectorToBlob(chunk.embedding));
        }

        if (insertFts) {
          insertFts.run(
            chunk.id,
            chunk.path,
            chunk.source,
            chunk.startLine,
            chunk.endLine,
            chunk.text,
            chunk.model,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async search(params: SearchParams): Promise<SearchResult[]> {
    const { queryText, queryVec, limit, sources, providerModel } = params;

    // Build source filters
    const sourceFilter = this.buildSourceFilter(sources);

    let vectorResults: any[] = [];
    let keywordResults: any[] = [];

    // 1. Vector Search
    if (queryVec && queryVec.length > 0) {
      vectorResults = await searchVector({
        db: this.db,
        vectorTable: this.vectorTable,
        providerModel,
        queryVec: queryVec,
        limit,
        snippetMaxChars: params.snippetMaxChars,
        ensureVectorReady: async () => this.vectorReady,
        sourceFilterVec: sourceFilter,
        sourceFilterChunks: sourceFilter,
      });
    }

    // 2. Keyword Search
    if (queryText && this.ftsEnabled && this.ftsAvailable) {
      keywordResults = await searchKeyword({
        db: this.db,
        ftsTable: this.ftsTable,
        providerModel,
        query: queryText,
        limit,
        snippetMaxChars: params.snippetMaxChars,
        sourceFilter,
        buildFtsQuery,
        bm25RankToScore,
      });
    }

    // 3. Merge
    if (vectorResults.length > 0 && keywordResults.length > 0) {
      const merged = mergeHybridResults({
        vector: vectorResults,
        keyword: keywordResults,
        vectorWeight: params.hybridWeights?.vector ?? 0.7,
        textWeight: params.hybridWeights?.text ?? 0.3,
      });
      return merged.map((r) => ({
        id: "", // merged result might not have single ID if logic changes, but currently it does
        ...r,
      })) as SearchResult[];
    }

    if (vectorResults.length > 0) return vectorResults;
    if (keywordResults.length > 0) return keywordResults.map((r) => ({ ...r, score: r.textScore }));

    return [];
  }

  async getCachedEmbedding(key: EmbeddingCacheKey): Promise<number[] | null> {
    const row = this.db
      .prepare(
        `SELECT embedding FROM ${this.embeddingCacheTable} ` +
          `WHERE provider = ? AND model = ? AND hash = ?`,
      )
      .get(key.provider, key.model, key.hash) as { embedding: string } | undefined;

    if (!row) return null;
    try {
      return JSON.parse(row.embedding);
    } catch {
      return null;
    }
  }

  async setCachedEmbedding(key: EmbeddingCacheKey, embedding: number[]): Promise<void> {
    const str = JSON.stringify(embedding);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.embeddingCacheTable} ` +
          `(provider, model, provider_key, hash, embedding, dims, updated_at) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key.provider, key.model, key.providerKey ?? "", key.hash, str, embedding.length, now);
  }

  async getStats(sources: string[]): Promise<{
    files: number;
    chunks: number;
    sourceCounts: Array<{ source: string; files: number; chunks: number }>;
    cacheEntries: number;
  }> {
    const sourceFilter = this.buildSourceFilter(sources);

    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as { c: number };

    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as { c: number };

    const sourceCounts: Array<{ source: string; files: number; chunks: number }> = [];
    if (sources.length > 0) {
      const bySource = new Map<string, { files: number; chunks: number }>();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }

      const fileRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: string; c: number }>;

      for (const row of fileRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.files = row.c;
        bySource.set(row.source, entry);
      }

      const chunkRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: string; c: number }>;

      for (const row of chunkRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.chunks = row.c;
        bySource.set(row.source, entry);
      }

      for (const source of sources) {
        sourceCounts.push({ source, ...bySource.get(source)! });
      }
    }

    const cacheEntries =
      (
        this.db.prepare(`SELECT COUNT(*) as c FROM ${this.embeddingCacheTable}`).get() as {
          c: number;
        }
      )?.c ?? 0;

    return {
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      sourceCounts,
      cacheEntries,
    };
  }

  private buildSourceFilter(sources: string[]) {
    if (sources.length === 0) return { sql: "", params: [] };
    const placeholders = sources.map(() => "?").join(",");
    return {
      sql: ` AND source IN (${placeholders})`,
      params: sources,
    };
  }
}

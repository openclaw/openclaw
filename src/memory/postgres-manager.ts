/**
 * PostgreSQL + pgvector memory backend for OpenClaw.
 *
 * Implements MemorySearchManager using PostgreSQL with the pgvector extension
 * for vector similarity search, replacing the SQLite-based builtin backend.
 *
 * Requires:
 *   - PostgreSQL 15+ with pgvector extension installed
 *   - An embedding provider (OpenAI, Voyage, Gemini, Ollama)
 *   - Connection string via memory.postgres.connectionString or OPENCLAW_MEMORY_PG env
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryPostgresConfig } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";

const log = createSubsystemLogger("memory-postgres");

const SNIPPET_MAX_CHARS = 700;
const CHUNK_SIZE_LINES = 30;
const CHUNK_OVERLAP_LINES = 5;
const DEFAULT_MIN_SIMILARITY = 0.3;
const DEFAULT_MAX_CONNECTIONS = 5;
const DEFAULT_DIMENSIONS = 1536; // OpenAI text-embedding-3-small default

// ── Row types for query results ─────────────────────────────────────────────

type VectorSearchRow = {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  source: string;
  similarity: string;
};

type FtsSearchRow = {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  source: string;
  rank: string;
};

type FileRow = { path: string };
type HashRow = { hash: string };
type CountRow = { c: string };

// ── Manager Cache ───────────────────────────────────────────────────────────

const PG_MANAGER_CACHE = new Map<string, PostgresMemoryManager>();

function buildPgCacheKey(agentId: string, connectionString: string): string {
  return `${agentId}:${connectionString}`;
}

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_files (
  path TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL,
  mtime BIGINT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (path, agent_id)
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding vector,
  model TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_agent ON memory_chunks(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_path ON memory_chunks(path);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_memory_chunks_fts
  ON memory_chunks USING gin(to_tsvector('english', text));
`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function chunkText(
  lines: string[],
  filePath: string,
  source: MemorySource,
  agentId: string,
): Array<{
  id: string;
  path: string;
  source: MemorySource;
  agentId: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}> {
  const chunks: Array<{
    id: string;
    path: string;
    source: MemorySource;
    agentId: string;
    startLine: number;
    endLine: number;
    text: string;
    hash: string;
  }> = [];

  for (let i = 0; i < lines.length; i += CHUNK_SIZE_LINES - CHUNK_OVERLAP_LINES) {
    const start = i;
    const end = Math.min(i + CHUNK_SIZE_LINES, lines.length);
    const text = lines.slice(start, end).join("\n");
    if (!text.trim()) {
      continue;
    }

    const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
    const id = `${agentId}:${filePath}:${start + 1}-${end}:${hash}`;

    chunks.push({
      id,
      path: filePath,
      source,
      agentId,
      startLine: start + 1,
      endLine: end,
      text,
      hash,
    });

    if (end >= lines.length) {
      break;
    }
  }
  return chunks;
}

function snippetFromText(text: string): string {
  if (text.length <= SNIPPET_MAX_CHARS) {
    return text;
  }
  return text.slice(0, SNIPPET_MAX_CHARS) + "…";
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class PostgresMemoryManager implements MemorySearchManager {
  private pool: pg.Pool;
  private provider: EmbeddingProvider | null = null;
  private dimensions: number;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly cfg: OpenClawConfig;
  private readonly pgConfig: MemoryPostgresConfig;
  private readonly minSimilarity: number;
  private readonly cacheKey: string;
  private schemaReady = false;
  private indexCreated = false;
  private fileCount = 0;
  private chunkCount = 0;
  private dirty = false;

  private constructor(params: {
    pool: pg.Pool;
    provider: EmbeddingProvider | null;
    dimensions: number;
    agentId: string;
    workspaceDir: string;
    cfg: OpenClawConfig;
    pgConfig: MemoryPostgresConfig;
    cacheKey: string;
  }) {
    this.pool = params.pool;
    this.provider = params.provider;
    this.dimensions = params.dimensions;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.cfg = params.cfg;
    this.pgConfig = params.pgConfig;
    this.minSimilarity = params.pgConfig.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    this.cacheKey = params.cacheKey;
  }

  /**
   * Get or create a PostgresMemoryManager instance (cached per agent + connection).
   */
  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): Promise<PostgresMemoryManager> {
    const pgConfig = params.cfg.memory?.postgres ?? {};
    const connectionString = pgConfig.connectionString || process.env.OPENCLAW_MEMORY_PG;

    if (!connectionString) {
      throw new Error(
        "PostgreSQL memory backend requires a connection string. " +
          "Set memory.postgres.connectionString in config or OPENCLAW_MEMORY_PG env var.",
      );
    }

    // Return cached manager if available
    const cacheKey = buildPgCacheKey(params.agentId, connectionString);
    const cached = PG_MANAGER_CACHE.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pool = new pg.Pool({
      connectionString,
      max: pgConfig.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    });

    // Test connection — clean up pool on failure
    try {
      const client = await pool.connect();
      client.release();
    } catch (err) {
      await pool.end().catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to PostgreSQL memory backend: ${message}`, {
        cause: err,
      });
    }

    const dimensions = pgConfig.embeddingDimensions ?? DEFAULT_DIMENSIONS;

    let workspaceDir: string;
    try {
      workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }

    // Create embedding provider using the same pattern as MemoryIndexManager
    let provider: EmbeddingProvider | null = null;
    try {
      const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
      if (settings) {
        const providerResult = await createEmbeddingProvider({
          config: params.cfg,
          agentDir: resolveAgentDir(params.cfg, params.agentId),
          provider: settings.provider,
          remote: settings.remote,
          model: settings.model,
          fallback: settings.fallback,
          local: settings.local,
        });
        provider = providerResult.provider;
      }
    } catch (err) {
      log.warn(
        `Embedding provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const manager = new PostgresMemoryManager({
      pool,
      provider,
      dimensions,
      agentId: params.agentId,
      workspaceDir,
      cfg: params.cfg,
      pgConfig,
      cacheKey,
    });

    await manager.ensureSchema();
    PG_MANAGER_CACHE.set(cacheKey, manager);
    return manager;
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query(SCHEMA_SQL);
      this.schemaReady = true;
    } finally {
      client.release();
    }
  }

  private async ensureVectorIndex(): Promise<void> {
    if (this.indexCreated) {
      return;
    }
    const client = await this.pool.connect();
    try {
      const indexType = this.pgConfig.indexType ?? "hnsw";
      if (indexType === "hnsw") {
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding_hnsw
          ON memory_chunks USING hnsw ((embedding::vector(${this.dimensions})) vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
        `);
      } else {
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding_ivfflat
          ON memory_chunks USING ivfflat ((embedding::vector(${this.dimensions})) vector_cosine_ops)
          WITH (lists = 100);
        `);
      }
      this.indexCreated = true;
    } catch (err) {
      // Index creation may fail if not enough rows; that's okay
      log.warn(
        `Vector index creation deferred: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      client.release();
    }
  }

  // ── MemorySearchManager interface ───────────────────────────────────────

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const maxResults = opts?.maxResults ?? 6;
    const minScore = opts?.minScore ?? this.minSimilarity;

    // Try vector search first, fall back to FTS
    let results: MemorySearchResult[] = [];

    if (this.provider) {
      try {
        results = await this.vectorSearch(query, maxResults, minScore);
      } catch (err) {
        log.warn(
          `Vector search failed, falling back to FTS: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (results.length === 0) {
      results = await this.ftsSearch(query, maxResults);
    }

    return results;
  }

  private async vectorSearch(
    query: string,
    maxResults: number,
    minScore: number,
  ): Promise<MemorySearchResult[]> {
    if (!this.provider) {
      return [];
    }

    const embedding = await this.provider.embedQuery(query);
    if (!embedding?.length) {
      return [];
    }

    const vecStr = `[${embedding.join(",")}]`;
    const client = await this.pool.connect();
    try {
      const result = await client.query<VectorSearchRow>(
        `SELECT path, start_line, end_line, text, source,
                1 - (embedding::vector(${this.dimensions}) <=> $1::vector(${this.dimensions})) as similarity
         FROM memory_chunks
         WHERE agent_id = $2
           AND embedding IS NOT NULL
         ORDER BY embedding::vector(${this.dimensions}) <=> $1::vector(${this.dimensions})
         LIMIT $3`,
        [vecStr, this.agentId, maxResults * 2],
      );

      return result.rows
        .filter((row) => parseFloat(row.similarity) >= minScore)
        .slice(0, maxResults)
        .map((row) => ({
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          score: parseFloat(row.similarity),
          snippet: snippetFromText(row.text),
          source: row.source as MemorySource,
          citation: `${row.path}#L${row.start_line}-L${row.end_line}`,
        }));
    } finally {
      client.release();
    }
  }

  private async ftsSearch(query: string, maxResults: number): Promise<MemorySearchResult[]> {
    const tsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
      .filter(Boolean)
      .join(" & ");

    if (!tsQuery) {
      return [];
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query<FtsSearchRow>(
        `SELECT path, start_line, end_line, text, source,
                ts_rank(to_tsvector('english', text), to_tsquery('english', $1)) as rank
         FROM memory_chunks
         WHERE agent_id = $2
           AND to_tsvector('english', text) @@ to_tsquery('english', $1)
         ORDER BY rank DESC
         LIMIT $3`,
        [tsQuery, this.agentId, maxResults],
      );

      return result.rows.map((row) => ({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: Math.min(parseFloat(row.rank), 1.0),
        snippet: snippetFromText(row.text),
        source: row.source as MemorySource,
        citation: `${row.path}#L${row.start_line}-L${row.end_line}`,
      }));
    } finally {
      client.release();
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    // Resolve and validate the path stays within the workspace
    const fullPath = path.resolve(this.workspaceDir, params.relPath);
    if (!fullPath.startsWith(this.workspaceDir + path.sep) && fullPath !== this.workspaceDir) {
      throw new Error(`Path traversal denied: ${params.relPath}`);
    }

    // Only allow reading memory paths (MEMORY.md, memory/*)
    const relNormalized = path.relative(this.workspaceDir, fullPath).replace(/\\/g, "/");
    if (!isMemoryPath(relNormalized)) {
      throw new Error(`Access denied: ${params.relPath} is not a memory path`);
    }

    const content = await fs.readFile(fullPath, "utf-8");
    const allLines = content.split("\n");

    const from = params.from ? params.from - 1 : 0;
    const end = params.lines ? from + params.lines : allLines.length;
    const text = allLines.slice(from, end).join("\n");

    return { text, path: params.relPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "postgres",
      provider: "postgres",
      model: this.pgConfig.embeddingModel,
      files: this.fileCount,
      chunks: this.chunkCount,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      vector: {
        enabled: true,
        available: this.provider !== null,
        dims: this.dimensions,
      },
      fts: {
        enabled: true,
        available: true,
      },
      custom: {
        backend: "postgres",
        indexType: this.pgConfig.indexType ?? "hnsw",
        minSimilarity: this.minSimilarity,
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    log.info(`Syncing memory files (reason: ${params?.reason ?? "manual"})...`);

    const memoryDir = path.join(this.workspaceDir, "memory");
    const memoryMd = path.join(this.workspaceDir, "MEMORY.md");

    const filesToSync: Array<{ fullPath: string; relPath: string; source: MemorySource }> = [];

    // MEMORY.md
    try {
      await fs.access(memoryMd);
      filesToSync.push({ fullPath: memoryMd, relPath: "MEMORY.md", source: "memory" });
    } catch {
      // No MEMORY.md, that's fine
    }

    // memory/*.md
    try {
      const entries = await fs.readdir(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          filesToSync.push({
            fullPath: path.join(memoryDir, entry.name),
            relPath: `memory/${entry.name}`,
            source: "memory",
          });
        }
      }
    } catch {
      // No memory dir
    }

    // Extra paths from config
    const settings = resolveMemorySearchConfig(this.cfg, this.agentId);
    const extraPaths = normalizeExtraMemoryPaths(this.workspaceDir, settings?.extraPaths);
    for (const extra of extraPaths) {
      try {
        const stat = await fs.stat(extra);
        if (stat.isFile() && extra.endsWith(".md")) {
          const relPath = path.relative(this.workspaceDir, extra);
          filesToSync.push({ fullPath: extra, relPath, source: "memory" });
        }
      } catch {
        // skip inaccessible
      }
    }

    const total = filesToSync.length;
    let completed = 0;

    for (const file of filesToSync) {
      try {
        await this.syncFile(file.fullPath, file.relPath, file.source);
      } catch (err) {
        log.warn(
          `Failed to sync ${file.relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      completed++;
      params?.progress?.({ completed, total, label: file.relPath });
    }

    // Prune files that no longer exist
    await this.pruneDeletedFiles(filesToSync.map((f) => f.relPath));

    // Update counts
    await this.updateCounts();

    // Try to create vector index if we have chunks
    if (this.chunkCount > 0) {
      await this.ensureVectorIndex();
    }

    this.dirty = false;
    log.info(`Memory sync complete: ${this.fileCount} files, ${this.chunkCount} chunks`);
  }

  private async syncFile(fullPath: string, relPath: string, source: MemorySource): Promise<void> {
    const stat = await fs.stat(fullPath);
    const content = await fs.readFile(fullPath, "utf-8");
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

    const client = await this.pool.connect();
    try {
      // Check if file changed
      const existing = await client.query<HashRow>(
        "SELECT hash FROM memory_files WHERE path = $1 AND agent_id = $2",
        [relPath, this.agentId],
      );

      if (existing.rows.length > 0 && existing.rows[0].hash === hash) {
        return; // File unchanged
      }

      // Use transaction for atomicity
      await client.query("BEGIN");
      try {
        // Upsert file record
        await client.query(
          `INSERT INTO memory_files (path, agent_id, source, hash, mtime, size)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (path, agent_id)
           DO UPDATE SET hash = $4, mtime = $5, size = $6, source = $3`,
          [relPath, this.agentId, source, hash, stat.mtimeMs, stat.size],
        );

        // Delete old chunks for this file
        await client.query("DELETE FROM memory_chunks WHERE path = $1 AND agent_id = $2", [
          relPath,
          this.agentId,
        ]);

        // Create new chunks
        const lines = content.split("\n");
        const chunks = chunkText(lines, relPath, source, this.agentId);

        for (const chunk of chunks) {
          let embedding: number[] | null = null;
          if (this.provider) {
            try {
              embedding = await this.provider.embedQuery(chunk.text);
            } catch (err) {
              log.warn(
                `Embedding failed for chunk ${chunk.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          const embeddingStr = embedding ? `[${embedding.join(",")}]` : null;
          const modelName = this.provider ? (this.pgConfig.embeddingModel ?? "default") : null;

          await client.query(
            `INSERT INTO memory_chunks (id, agent_id, path, source, start_line, end_line, hash, text, embedding, model)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10)
             ON CONFLICT (id) DO UPDATE SET
               text = $8, embedding = $9::vector, model = $10, hash = $7, updated_at = now()`,
            [
              chunk.id,
              this.agentId,
              chunk.path,
              chunk.source,
              chunk.startLine,
              chunk.endLine,
              chunk.hash,
              chunk.text,
              embeddingStr,
              modelName,
            ],
          );
        }

        await client.query("COMMIT");
        this.dirty = true;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } finally {
      client.release();
    }
  }

  private async pruneDeletedFiles(currentPaths: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<FileRow>(
        "SELECT path FROM memory_files WHERE agent_id = $1",
        [this.agentId],
      );

      const currentSet = new Set(currentPaths);
      const toDelete = result.rows.map((r) => r.path).filter((p) => !currentSet.has(p));

      for (const filePath of toDelete) {
        await client.query("DELETE FROM memory_chunks WHERE path = $1 AND agent_id = $2", [
          filePath,
          this.agentId,
        ]);
        await client.query("DELETE FROM memory_files WHERE path = $1 AND agent_id = $2", [
          filePath,
          this.agentId,
        ]);
      }
    } finally {
      client.release();
    }
  }

  private async updateCounts(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const files = await client.query<CountRow>(
        "SELECT COUNT(*) as c FROM memory_files WHERE agent_id = $1",
        [this.agentId],
      );
      const chunks = await client.query<CountRow>(
        "SELECT COUNT(*) as c FROM memory_chunks WHERE agent_id = $1",
        [this.agentId],
      );
      this.fileCount = parseInt(files.rows[0].c, 10);
      this.chunkCount = parseInt(chunks.rows[0].c, 10);
    } finally {
      client.release();
    }
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.provider) {
      return { ok: false, error: "No embedding provider configured" };
    }
    try {
      const result = await this.provider.embedQuery("test");
      return { ok: result !== null && result.length > 0 };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT '[1,2,3]'::vector");
      return true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    PG_MANAGER_CACHE.delete(this.cacheKey);
    await this.pool.end();
  }
}

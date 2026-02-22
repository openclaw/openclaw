import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedMemoryBackendConfig, ResolvedPostgresConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/postgres");

const SNIPPET_MAX_CHARS = 700;

// pg types are pulled dynamically; declare minimal shapes for type-safety
// without requiring @types/pg at build time.
interface PgPoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: { rejectUnauthorized?: boolean } | undefined;
  max?: number;
  idleTimeoutMillis?: number;
}

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/**
 * Dynamically import the `pg` module.  Returns `null` when `pg` is not
 * installed so callers can produce a clear error message.
 */
async function importPg(): Promise<{ Pool: new (config: PgPoolConfig) => PgPool } | null> {
  try {
    // Dynamic import with type suppression — pg ships without types and
    // we define our own minimal interfaces above.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
    return await import("pg");
  } catch {
    return null;
  }
}

function buildPoolConfig(cfg: ResolvedPostgresConfig): PgPoolConfig {
  if (cfg.connectionString) {
    return {
      connectionString: cfg.connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
    };
  }
  return {
    host: cfg.host ?? "localhost",
    port: cfg.port ?? 5432,
    database: cfg.database ?? "openclaw",
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl === true || cfg.ssl === "require" ? { rejectUnauthorized: true } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
  };
}

function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function extractSnippet(content: string, maxChars: number = SNIPPET_MAX_CHARS): string {
  return content.slice(0, maxChars);
}

/**
 * Recursively list files in `dir` matching a simple glob pattern.
 * Supports `*.md`, `**\/*.md`, and exact filenames.
 */
async function walkCollectionDir(dir: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  const recursive = pattern.startsWith("**/");
  const ext = pattern.replace(/^\*\*\//, "").replace(/^\*/, "");

  async function walk(current: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && recursive) {
        await walk(full);
      } else if (entry.isFile()) {
        if (pattern === entry.name || entry.name.endsWith(ext)) {
          results.push(full);
        }
      }
    }
  }

  await walk(dir);
  return results;
}

export class PostgresMemoryManager implements MemorySearchManager {
  private readonly cfg: OpenClawConfig;
  private readonly agentId: string;
  private readonly pgCfg: ResolvedPostgresConfig;
  private readonly workspaceDir: string;
  private readonly tableName: string;
  private pool: PgPool | null = null;
  private initialized = false;
  private lastSyncAt?: number;
  private docCount = 0;
  private embeddingAvailable = false;

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
  }): Promise<PostgresMemoryManager | null> {
    const pgCfg = params.resolved.postgres;
    if (!pgCfg) {
      return null;
    }
    const manager = new PostgresMemoryManager({
      cfg: params.cfg,
      agentId: params.agentId,
      pgCfg,
    });
    await manager.initialize();
    return manager;
  }

  private constructor(params: {
    cfg: OpenClawConfig;
    agentId: string;
    pgCfg: ResolvedPostgresConfig;
  }) {
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.pgCfg = params.pgCfg;
    this.workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    this.tableName = `${params.pgCfg.tablePrefix}_documents`;
  }

  private async initialize(): Promise<void> {
    const pg = await importPg();
    if (!pg) {
      throw new Error(
        'PostgreSQL memory backend requires the "pg" package. Install it with: pnpm add pg',
      );
    }
    const poolConfig = buildPoolConfig(this.pgCfg);
    this.pool = new pg.Pool(poolConfig);

    // Verify connection and create tables if needed.
    try {
      await this.ensureSchema();
      this.initialized = true;
      log.info("postgres memory backend initialized");
    } catch (err) {
      log.error(`postgres initialization failed: ${String(err)}`);
      throw err;
    }
  }

  private async ensureSchema(): Promise<void> {
    const pool = this.requirePool();
    const table = this.tableName;
    const dims = this.pgCfg.embedding.dimensions;

    // Enable pgvector extension (requires superuser or CREATE permission on first run).
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => {
      log.warn("pgvector extension not available; vector search will be disabled");
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id SERIAL PRIMARY KEY,
        collection TEXT NOT NULL,
        doc_path TEXT NOT NULL,
        doc_hash TEXT NOT NULL,
        content TEXT,
        snippet TEXT,
        embedding vector(${dims}),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(collection, doc_path)
      )
    `);

    // Create indexes idempotently.
    await pool
      .query(
        `CREATE INDEX IF NOT EXISTS idx_${this.pgCfg.tablePrefix}_embedding
       ON ${table} USING ivfflat (embedding vector_cosine_ops)`,
      )
      .catch(() => {
        // IVFFlat requires training data; fall back to HNSW or skip if no rows yet.
        return pool
          .query(
            `CREATE INDEX IF NOT EXISTS idx_${this.pgCfg.tablePrefix}_embedding
           ON ${table} USING hnsw (embedding vector_cosine_ops)`,
          )
          .catch(() => {
            log.warn("could not create vector index; searches may be slow");
          });
      });

    // tsvector column for hybrid search (add if not exists).
    await pool
      .query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS
       tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED`,
      )
      .catch(() => {
        // Column may already exist or generated columns not supported.
      });

    await pool
      .query(
        `CREATE INDEX IF NOT EXISTS idx_${this.pgCfg.tablePrefix}_tsv ON ${table} USING gin (tsv)`,
      )
      .catch(() => {});

    await pool
      .query(
        `CREATE INDEX IF NOT EXISTS idx_${this.pgCfg.tablePrefix}_active
       ON ${table} (collection, active)`,
      )
      .catch(() => {});

    // Get doc count.
    const countResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM ${table} WHERE active = true`,
    );
    this.docCount = Number(countResult.rows[0]?.cnt ?? 0);
  }

  private requirePool(): PgPool {
    if (!this.pool) {
      throw new Error("PostgreSQL pool not initialized");
    }
    return this.pool;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const pool = this.requirePool();
    const maxResults = opts?.maxResults ?? this.pgCfg.limits.maxResults;
    const minScore = opts?.minScore ?? 0;

    // Try to get query embedding for vector search.
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await this.embedText(query);
    } catch (err) {
      log.warn(`embedding failed, falling back to text-only search: ${String(err)}`);
    }

    const hybrid = this.pgCfg.hybrid;
    const table = this.tableName;

    if (queryEmbedding && hybrid.enabled) {
      // Hybrid search: vector + text.
      const embeddingStr = `[${queryEmbedding.join(",")}]`;
      const result = await pool.query(
        `
        WITH vector_results AS (
          SELECT id, doc_path, collection, content,
                 1 - (embedding <=> $1::vector) AS vector_score
          FROM ${table}
          WHERE active = true AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        ),
        text_results AS (
          SELECT id, doc_path, collection, content,
                 ts_rank_cd(tsv, plainto_tsquery('english', $3)) AS text_score
          FROM ${table}
          WHERE active = true AND tsv @@ plainto_tsquery('english', $3)
          LIMIT $2
        )
        SELECT COALESCE(v.id, t.id) AS id,
               COALESCE(v.doc_path, t.doc_path) AS doc_path,
               COALESCE(v.collection, t.collection) AS collection,
               COALESCE(v.content, t.content) AS content,
               ($4 * COALESCE(v.vector_score, 0) + $5 * COALESCE(t.text_score, 0)) AS score
        FROM vector_results v
        FULL OUTER JOIN text_results t ON v.id = t.id
        ORDER BY score DESC
        LIMIT $2
        `,
        [embeddingStr, maxResults * 4, query, hybrid.vectorWeight, hybrid.textWeight],
      );
      return this.rowsToResults(result.rows, minScore, maxResults);
    }

    if (queryEmbedding) {
      // Vector-only search.
      const embeddingStr = `[${queryEmbedding.join(",")}]`;
      const result = await pool.query(
        `
        SELECT id, doc_path, collection, content,
               1 - (embedding <=> $1::vector) AS score
        FROM ${table}
        WHERE active = true AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2
        `,
        [embeddingStr, maxResults],
      );
      return this.rowsToResults(result.rows, minScore, maxResults);
    }

    // Text-only fallback.
    const result = await pool.query(
      `
      SELECT id, doc_path, collection, content,
             ts_rank_cd(tsv, plainto_tsquery('english', $1)) AS score
      FROM ${table}
      WHERE active = true AND tsv @@ plainto_tsquery('english', $1)
      ORDER BY score DESC
      LIMIT $2
      `,
      [query, maxResults],
    );
    return this.rowsToResults(result.rows, minScore, maxResults);
  }

  private rowsToResults(
    rawRows: Record<string, unknown>[],
    minScore: number,
    maxResults: number,
  ): MemorySearchResult[] {
    type Row = { doc_path: string; collection: string; content: string; score: number };
    const rows = rawRows as unknown as Row[];
    return rows
      .filter((row) => (row.score ?? 0) >= minScore)
      .slice(0, maxResults)
      .map((row) => ({
        path: row.doc_path ?? "",
        startLine: 1,
        endLine: (row.content ?? "").split("\n").length,
        score: Number(row.score ?? 0),
        snippet: extractSnippet(row.content ?? ""),
        source: ((row.collection ?? "").includes("session")
          ? "sessions"
          : "memory") as MemorySource,
      }));
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    // Read from the filesystem, same as QMD manager.
    const absPath = path.isAbsolute(params.relPath)
      ? params.relPath
      : path.resolve(this.workspaceDir, params.relPath);
    const content = await fs.readFile(absPath, "utf-8");
    const allLines = content.split("\n");
    const from = Math.max(0, (params.from ?? 1) - 1);
    const count = params.lines ?? allLines.length;
    const selected = allLines.slice(from, from + count);
    return { text: selected.join("\n"), path: absPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "qmd", // Report as qmd for interface compatibility; custom field clarifies.
      provider: this.pgCfg.embedding.provider,
      model: this.pgCfg.embedding.model,
      files: this.docCount,
      chunks: this.docCount,
      workspaceDir: this.workspaceDir,
      sources: ["memory", "sessions"],
      vector: {
        enabled: true,
        available: this.embeddingAvailable,
        dims: this.pgCfg.embedding.dimensions,
      },
      custom: {
        backend: "postgres",
        tablePrefix: this.pgCfg.tablePrefix,
        hybrid: this.pgCfg.hybrid.enabled,
        lastSyncAt: this.lastSyncAt,
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const pool = this.requirePool();
    const collections = this.pgCfg.collections;
    let totalProcessed = 0;
    let totalFiles = 0;

    // Collect all files from all collections.
    const fileEntries: Array<{ collection: string; filePath: string; relPath: string }> = [];
    for (const col of collections) {
      try {
        const files = await walkCollectionDir(col.path, col.pattern);
        for (const file of files) {
          fileEntries.push({
            collection: col.name,
            filePath: file,
            relPath: path.relative(this.workspaceDir, file),
          });
        }
      } catch (err) {
        log.warn(`failed to scan collection ${col.name}: ${String(err)}`);
      }
    }
    totalFiles = fileEntries.length;

    for (const entry of fileEntries) {
      try {
        const content = await fs.readFile(entry.filePath, "utf-8");
        const hash = contentHash(content);

        // Check if doc exists and is unchanged.
        const existing = await pool.query(
          `SELECT doc_hash FROM ${this.tableName} WHERE collection = $1 AND doc_path = $2`,
          [entry.collection, entry.relPath],
        );

        if (existing.rows[0]?.doc_hash === hash && !params?.force) {
          totalProcessed += 1;
          params?.progress?.({ completed: totalProcessed, total: totalFiles });
          continue;
        }

        // Generate embedding.
        let embedding: number[] | null = null;
        try {
          embedding = await this.embedText(content.slice(0, 8000)); // Limit content for embedding.
        } catch {
          // Skip embedding on failure; text search still works.
        }

        const embeddingStr = embedding ? `[${embedding.join(",")}]` : null;
        const snippet = extractSnippet(content);

        await pool.query(
          `INSERT INTO ${this.tableName} (collection, doc_path, doc_hash, content, snippet, embedding, active)
           VALUES ($1, $2, $3, $4, $5, $6::vector, true)
           ON CONFLICT (collection, doc_path) DO UPDATE SET
             doc_hash = EXCLUDED.doc_hash,
             content = EXCLUDED.content,
             snippet = EXCLUDED.snippet,
             embedding = COALESCE(EXCLUDED.embedding, ${this.tableName}.embedding),
             active = true,
             updated_at = now()`,
          [entry.collection, entry.relPath, hash, content, snippet, embeddingStr],
        );

        totalProcessed += 1;
        params?.progress?.({ completed: totalProcessed, total: totalFiles });
      } catch (err) {
        log.warn(`failed to sync ${entry.relPath}: ${String(err)}`);
        totalProcessed += 1;
      }
    }

    // Mark deleted files as inactive.
    const activePaths = fileEntries.map((e) => e.relPath);
    if (activePaths.length > 0) {
      const collectionsUsed = [...new Set(collections.map((c) => c.name))];
      for (const col of collectionsUsed) {
        const colPaths = fileEntries.filter((e) => e.collection === col).map((e) => e.relPath);
        if (colPaths.length > 0) {
          await pool
            .query(
              `UPDATE ${this.tableName} SET active = false, updated_at = now()
             WHERE collection = $1 AND active = true AND doc_path != ALL($2)`,
              [col, colPaths],
            )
            .catch(() => {});
        }
      }
    }

    this.lastSyncAt = Date.now();
    // Refresh doc count.
    const countResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM ${this.tableName} WHERE active = true`,
    );
    this.docCount = Number(countResult.rows[0]?.cnt ?? 0);
    log.info(`sync complete: ${this.docCount} active documents`);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const embedding = await this.embedText("test");
      this.embeddingAvailable = embedding.length > 0;
      return { ok: this.embeddingAvailable };
    } catch (err) {
      this.embeddingAvailable = false;
      return { ok: false, error: String(err) };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      const pool = this.requirePool();
      await pool.query("SELECT '[1,2,3]'::vector");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private embeddingProvider: import("./embeddings.js").EmbeddingProvider | null = null;

  private async embedText(text: string): Promise<number[]> {
    if (!this.embeddingProvider) {
      const { createEmbeddingProvider } = await import("./embeddings.js");
      const result = await createEmbeddingProvider({
        config: this.cfg,
        provider: this.pgCfg.embedding.provider,
        model: this.pgCfg.embedding.model,
        fallback: "none",
      });
      if (!result?.provider) {
        throw new Error(`embedding provider "${this.pgCfg.embedding.provider}" not available`);
      }
      this.embeddingProvider = result.provider;
    }
    return await this.embeddingProvider.embedQuery(text);
  }
}

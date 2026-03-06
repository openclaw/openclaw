import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolConfig } from "pg";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveSessionFilePath, resolveStorePath } from "../config/sessions/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { truncateUtf16Safe } from "../utils.js";
import { computeEmbeddingProviderKey } from "./provider-key.js";
import {
  buildFileEntry,
  chunkMarkdown,
  hashText,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";
import { mergeHybridResults } from "./hybrid.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type GeminiEmbeddingClient,
  type OpenAiEmbeddingClient,
} from "./embeddings.js";

type MemorySource = "memory" | "sessions";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
};

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  sessionKey?: string;
  userId?: string;
  messages: Array<{ role: "user" | "assistant"; text: string; createdAt?: number }>;
};

type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

type SessionIdentity = {
  sessionKey: string;
  userId?: string;
  originLabel?: string;
  channel?: string;
};

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;

const log = createSubsystemLogger("memory");

const vectorLiteral = (embedding: number[]): string =>
  `[${embedding.map((value) => Number(value).toFixed(8)).join(",")}]`;

const quoteIdent = (value: string): string => `"${value.replace(/"/g, "\"\"")}"`;

function buildMemoryPgUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const user = env.OPENCLAW_PG_USER?.trim();
  const password = env.OPENCLAW_PG_PASSWORD?.trim();
  const host = env.OPENCLAW_PG_HOST?.trim() || env.OPENCLAW_MEMORY_PG_HOST?.trim() || "localhost";
  const port = env.OPENCLAW_PG_PORT?.trim() || env.OPENCLAW_MEMORY_PG_PORT?.trim() || "5432";
  const db = env.OPENCLAW_PG_DB?.trim() || env.OPENCLAW_MEMORY_PG_DB?.trim();
  if (!user || !db) {
    return undefined;
  }
  const enc = encodeURIComponent;
  const auth = password ? `${enc(user)}:${enc(password)}` : enc(user);
  return `postgresql://${auth}@${host}:${port}/${enc(db)}`;
}

const resolvePgPoolConfig = (params: {
  config: OpenClawConfig;
  settings: ResolvedMemorySearchConfig;
}): PoolConfig => {
  const pg = params.settings.store.postgres ?? {};
  const connectionString =
    pg.connectionString?.trim() ||
    process.env.OPENCLAW_MEMORY_PG_URL?.trim() ||
    buildMemoryPgUrlFromEnv() ||
    undefined;
  const ssl = pg.ssl ?? (process.env.OPENCLAW_MEMORY_PG_SSL === "1" ? true : undefined);
  return {
    connectionString,
    host: connectionString ? undefined : pg.host,
    port: connectionString ? undefined : pg.port,
    user: connectionString ? undefined : pg.user,
    password: connectionString ? undefined : pg.password,
    database: connectionString ? undefined : pg.database,
    ssl,
  };
};

const resolveSchema = (settings: ResolvedMemorySearchConfig): string =>
  settings.store.postgres?.schema?.trim() || "public";

export class PostgresMemoryIndexManager {
  private readonly cfg: OpenClawConfig;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly settings: ResolvedMemorySearchConfig;
  private readonly sources: Set<MemorySource>;
  private readonly schema: string;
  private readonly pool: Pool;
  private provider: EmbeddingProvider;
  private readonly requestedProvider: "openai" | "local" | "gemini" | "auto";
  private fallbackFrom?: "openai" | "local" | "gemini";
  private fallbackReason?: string;
  private openAi?: OpenAiEmbeddingClient;
  private gemini?: GeminiEmbeddingClient;
  private providerKey: string;
  private dirty = false;
  private closed = false;
  private vectorDims?: number;
  private vectorAvailable: boolean | null = null;
  private syncing: Promise<void> | null = null;
  private sessionWarm = new Set<string>();
  private readonly cache: { enabled: boolean; maxEntries?: number };
  private lastCounts: {
    files: number;
    chunks: number;
    sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
    cacheEntries?: number;
  } = { files: 0, chunks: 0, sourceCounts: [] };

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): Promise<PostgresMemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings || settings.store.driver !== "postgres") {
      return null;
    }
    const providerResult = await createEmbeddingProvider({
      config: cfg,
      agentDir: resolveAgentDir(cfg, agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });
    return new PostgresMemoryIndexManager({
      cfg,
      agentId,
      settings,
      provider: providerResult.provider,
      requestedProvider: providerResult.requestedProvider,
      fallbackFrom: providerResult.fallbackFrom,
      fallbackReason: providerResult.fallbackReason,
      openAi: providerResult.openAi,
      gemini: providerResult.gemini,
    });
  }

  private constructor(params: {
    cfg: OpenClawConfig;
    agentId: string;
    settings: ResolvedMemorySearchConfig;
    provider: EmbeddingProvider;
    requestedProvider: "openai" | "local" | "gemini" | "auto";
    fallbackFrom?: "openai" | "local" | "gemini";
    fallbackReason?: string;
    openAi?: OpenAiEmbeddingClient;
    gemini?: GeminiEmbeddingClient;
  }) {
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.settings = params.settings;
    this.provider = params.provider;
    this.requestedProvider = params.requestedProvider;
    this.fallbackFrom = params.fallbackFrom;
    this.fallbackReason = params.fallbackReason;
    this.openAi = params.openAi;
    this.gemini = params.gemini;
    this.workspaceDir = resolveAgentWorkspaceDir(this.cfg, this.agentId);
    this.sources = new Set(params.settings.sources);
    this.schema = resolveSchema(params.settings);
    this.pool = new Pool(resolvePgPoolConfig({ config: params.cfg, settings: params.settings }));
    this.providerKey = computeEmbeddingProviderKey({
      providerId: this.provider.id,
      providerModel: this.provider.model,
      openAi: this.openAi
        ? {
            baseUrl: this.openAi.baseUrl,
            model: this.provider.model,
            headers: this.openAi.headers ?? {},
          }
        : undefined,
      gemini: this.gemini
        ? {
            baseUrl: this.gemini.baseUrl,
            model: this.provider.model,
            headers: this.gemini.headers ?? {},
          }
        : undefined,
    });
    this.cache = {
      enabled: this.settings.cache.enabled,
      maxEntries: this.settings.cache.maxEntries,
    };
    this.dirty = this.sources.has("memory");
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    // Deduplicate warmSession calls per session to avoid duplicate syncs
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      log.debug(`memory sync: warmSession skipped (already warmed): ${key}`);
      return;
    }
    log.debug(`memory sync: warmSession starting (reason=session-start, sessionKey=${key || "none"})`);
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
      // Clear after a delay to allow re-sync if session file changes
      setTimeout(() => {
        this.sessionWarm.delete(key);
      }, 60_000); // 1 minute
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      sessionScope?: "session" | "actor" | "global";
      actorId?: string;
      actorType?: string;
      role?: string;
      mode?: "hybrid" | "vector" | "keyword";
      updatedAfter?: number;
      updatedBefore?: number;
    },
  ): Promise<MemorySearchResult[]> {
    void this.warmSession();
    if (this.settings.sync.onSearch && this.dirty) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      });
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;
    const mode = opts?.mode ?? (hybrid.enabled ? "hybrid" : "vector");
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    const sessionKey = opts?.sessionKey?.trim() || undefined;
    const sessionScope = opts?.sessionScope ?? "session";
    const actorId = opts?.actorId?.trim() || undefined;
    const actorType = opts?.actorType?.trim() || undefined;
    const role = opts?.role?.trim() || undefined;
    const keywordResults =
      mode !== "vector" && hybrid.enabled
        ? await this.searchKeyword(cleaned, candidates, {
            sessionKey,
            sessionScope,
            actorId,
            actorType,
            role,
            updatedAfter: opts?.updatedAfter,
            updatedBefore: opts?.updatedBefore,
          }).catch(() => [])
        : [];
    const queryVec = mode !== "keyword" ? await this.provider.embedQuery(cleaned) : [];
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults =
      mode !== "keyword" && hasVector
        ? await this.searchVector(queryVec, candidates, {
            sessionKey,
            sessionScope,
            actorId,
            actorType,
            role,
            updatedAfter: opts?.updatedAfter,
            updatedBefore: opts?.updatedBefore,
          }).catch(() => [])
        : [];

    if (mode === "keyword") {
      return keywordResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }
    if (mode === "vector" || !hybrid.enabled) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const merged = mergeHybridResults({
      vector: vectorResults.map((entry) => ({
        id: entry.id,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        source: entry.source,
        snippet: entry.snippet,
        vectorScore: entry.score,
      })),
      keyword: keywordResults.map((entry) => ({
        id: entry.id,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        source: entry.source,
        snippet: entry.snippet,
        textScore: entry.textScore,
      })),
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
    });

    return merged
      .filter(
        (entry) =>
          entry.score >= minScore &&
          (entry.source === "memory" || entry.source === "sessions"),
      )
      .slice(0, maxResults)
      .map((entry) => ({
        ...entry,
        source: entry.source as MemorySource,
      }));
  }

  async sync(params?: {
    reason?: string;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.syncing) {
      log.debug(`memory sync: sync already in progress (reason=${params?.reason || "unknown"}), reusing existing promise`);
      return this.syncing;
    }
    log.debug(`memory sync: starting sync (reason=${params?.reason || "unknown"})`);
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
      log.debug(`memory sync: sync completed (reason=${params?.reason || "unknown"})`);
    });
    return this.syncing;
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
    let allowedAdditional = false;
    if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
      for (const additionalPath of additionalPaths) {
        try {
          const stat = await fs.lstat(additionalPath);
          if (stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
              allowedAdditional = true;
              break;
            }
            continue;
          }
          if (stat.isFile()) {
            if (absPath === additionalPath && absPath.endsWith(".md")) {
              allowedAdditional = true;
              break;
            }
          }
        } catch {}
      }
    }
    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("path required");
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): {
    files: number;
    chunks: number;
    dirty: boolean;
    workspaceDir: string;
    dbPath: string;
    provider: string;
    model: string;
    requestedProvider: string;
    sources: MemorySource[];
    extraPaths: string[];
    sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
    cache?: { enabled: boolean; entries?: number; maxEntries?: number };
    fts?: { enabled: boolean; available: boolean; error?: string };
    fallback?: { from: string; reason?: string };
    vector?: {
      enabled: boolean;
      available?: boolean;
      extensionPath?: string;
      loadError?: string;
      dims?: number;
    };
  } {
    const sources = Array.from(this.sources);
    const sourceCounts =
      this.lastCounts.sourceCounts.length > 0
        ? this.lastCounts.sourceCounts
        : sources.map((source) => ({ source, files: 0, chunks: 0 }));
    const dbPath =
      this.settings.store.postgres?.connectionString?.replace(/:[^:@/]+@/, ":***@") ?? "postgres";
    return {
      files: this.lastCounts.files,
      chunks: this.lastCounts.chunks,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath,
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      sources,
      extraPaths: this.settings.extraPaths,
      sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries: this.lastCounts.cacheEntries,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.settings.query.hybrid.enabled,
        available: true,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.settings.store.vector.enabled,
        available: this.vectorAvailable ?? undefined,
        dims: this.vectorDims,
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return this.ensureVectorExtension();
  }

  async probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.provider.embedBatch(["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pool.end();
  }

  async lookupActors(params: {
    query: string;
    limit?: number;
  }): Promise<
    Array<{
      actorId: string;
      actorType: string;
      displayName?: string | null;
      metadata?: unknown;
      aliases: string[];
      confidence?: number | null;
    }>
  > {
    const query = params.query.trim();
    if (!query) {
      return [];
    }
    const schema = quoteIdent(this.schema);
    const norm = query.toLowerCase();
    const like = `%${norm}%`;
    const limit = Math.max(1, Math.min(50, params.limit ?? 10));
    const rows = await this.pool.query(
      `SELECT a.actor_id, a.actor_type, a.display_name, a.metadata,` +
        ` array_remove(array_agg(DISTINCT al.alias), NULL) AS aliases,` +
        ` max(al.confidence) AS confidence` +
        ` FROM ${schema}.memory_actors a` +
        ` LEFT JOIN ${schema}.memory_actor_aliases al ON al.actor_id = a.actor_id` +
        ` WHERE (al.alias_norm LIKE $1 OR lower(a.display_name) LIKE $1)` +
        ` GROUP BY a.actor_id, a.actor_type, a.display_name, a.metadata` +
        ` ORDER BY confidence DESC NULLS LAST, a.display_name ASC NULLS LAST` +
        ` LIMIT $2`,
      [like, limit],
    );
    return (rows.rows as Array<{
      actor_id: string;
      actor_type: string;
      display_name: string | null;
      metadata: unknown;
      aliases: string[] | null;
      confidence: number | null;
    }>).map((row) => ({
      actorId: row.actor_id,
      actorType: row.actor_type,
      displayName: row.display_name,
      metadata: row.metadata,
      aliases: row.aliases ?? [],
      confidence: row.confidence ?? null,
    }));
  }

  private async runSync(params?: {
    reason?: string;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    await this.ensureSchema();
    const meta = await this.readMeta();
    if (meta?.vectorDims) {
      this.vectorDims = meta.vectorDims;
    }
    const baseMeta: MemoryIndexMeta = {
      model: this.provider.model,
      provider: this.provider.id,
      providerKey: this.providerKey,
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
      vectorDims: this.vectorDims,
    };
    const needsFullReindex =
      !meta ||
      meta.model !== baseMeta.model ||
      meta.provider !== baseMeta.provider ||
      meta.providerKey !== baseMeta.providerKey ||
      meta.chunkTokens !== baseMeta.chunkTokens ||
      meta.chunkOverlap !== baseMeta.chunkOverlap ||
      (meta.vectorDims && baseMeta.vectorDims && meta.vectorDims !== baseMeta.vectorDims);
    if (needsFullReindex) {
      await this.clearIndex();
      await this.writeMeta(baseMeta);
    }
    const progress = params?.progress;
    const progressState = progress
      ? { completed: 0, total: 0, report: progress }
      : null;

    if (this.sources.has("memory")) {
      await this.syncMemoryFiles(progressState ?? undefined);
    }
    if (this.sources.has("sessions") && this.settings.experimental.sessionMemory) {
      await this.syncSessionFiles(progressState ?? undefined);
    }

    if (this.vectorDims && (!meta || meta.vectorDims !== this.vectorDims)) {
      await this.writeMeta({ ...baseMeta, vectorDims: this.vectorDims });
    }
    await this.refreshCounts();
    this.dirty = false;
  }

  private async ensureSchema(): Promise<void> {
    const schema = quoteIdent(this.schema);
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.memory_meta (` +
        ` key TEXT PRIMARY KEY, value JSONB NOT NULL );`,
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.memory_files (` +
        ` path TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'memory',` +
        ` session_key TEXT, role TEXT, actor_type TEXT, actor_id TEXT,` +
        ` hash TEXT NOT NULL, mtime BIGINT NOT NULL, size BIGINT NOT NULL );`,
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.memory_chunks (` +
        ` id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',` +
        ` session_key TEXT, role TEXT, actor_type TEXT, actor_id TEXT,` +
        ` message_id TEXT, message_created_at BIGINT,` +
        ` start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,` +
        ` model TEXT NOT NULL, text TEXT NOT NULL, embedding vector,` +
        ` created_at BIGINT, updated_at BIGINT NOT NULL );`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_files ADD COLUMN IF NOT EXISTS session_key TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_files ADD COLUMN IF NOT EXISTS role TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_files ADD COLUMN IF NOT EXISTS actor_type TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_files ADD COLUMN IF NOT EXISTS actor_id TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_chunks ADD COLUMN IF NOT EXISTS session_key TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_chunks ADD COLUMN IF NOT EXISTS role TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_chunks ADD COLUMN IF NOT EXISTS actor_type TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_chunks ADD COLUMN IF NOT EXISTS actor_id TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_chunks ADD COLUMN IF NOT EXISTS created_at BIGINT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_chunks ADD COLUMN IF NOT EXISTS message_id TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_chunks ADD COLUMN IF NOT EXISTS message_created_at BIGINT;`,
    );
    await this.pool.query(
      `ALTER TABLE ${schema}.memory_chunks ` +
        `ADD COLUMN IF NOT EXISTS text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;`,
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.embedding_cache (` +
        ` provider TEXT NOT NULL, model TEXT NOT NULL, provider_key TEXT NOT NULL, hash TEXT NOT NULL,` +
        ` embedding vector NOT NULL, dims INTEGER, updated_at BIGINT NOT NULL,` +
        ` PRIMARY KEY (provider, model, provider_key, hash));`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_path ON ${schema}.memory_chunks(path);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON ${schema}.memory_chunks(source);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_model ON ${schema}.memory_chunks(model);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_session_key ON ${schema}.memory_chunks(session_key);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_actor_id ON ${schema}.memory_chunks(actor_id);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_created_at ON ${schema}.memory_chunks(created_at);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_updated_at ON ${schema}.memory_chunks(updated_at);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_message_id ON ${schema}.memory_chunks(message_id);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_message_created_at ON ${schema}.memory_chunks(message_created_at);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_session_message ON ${schema}.memory_chunks(session_key, message_created_at DESC);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_chunks_text ON ${schema}.memory_chunks USING gin (text_tsv);`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${schema}.embedding_cache(updated_at);`,
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.memory_actors (` +
        ` actor_id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, display_name TEXT,` +
        ` metadata JSONB, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL );`,
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.memory_actor_aliases (` +
        ` alias TEXT NOT NULL, alias_norm TEXT NOT NULL, actor_id TEXT NOT NULL,` +
        ` source TEXT, confidence REAL, metadata JSONB, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,` +
        ` PRIMARY KEY (alias_norm, actor_id),` +
        ` FOREIGN KEY (actor_id) REFERENCES ${schema}.memory_actors(actor_id) ON DELETE CASCADE );`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_actor_aliases_norm ON ${schema}.memory_actor_aliases(alias_norm);`,
    );
    this.vectorAvailable = true;
  }

  private async ensureVectorExtension(): Promise<boolean> {
    if (this.vectorAvailable !== null) {
      return this.vectorAvailable;
    }
    try {
      await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      this.vectorAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`pgvector unavailable: ${message}`);
      this.vectorAvailable = false;
    }
    return this.vectorAvailable;
  }

  private async readMeta(): Promise<MemoryIndexMeta | null> {
    const schema = quoteIdent(this.schema);
    const row = await this.pool.query(
      `SELECT value FROM ${schema}.memory_meta WHERE key = $1`,
      [META_KEY],
    );
    const value = row.rows[0]?.value;
    if (!value) {
      return null;
    }
    return value as MemoryIndexMeta;
  }

  private async writeMeta(meta: MemoryIndexMeta): Promise<void> {
    const schema = quoteIdent(this.schema);
    await this.pool.query(
      `INSERT INTO ${schema}.memory_meta (key, value)` +
        ` VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [META_KEY, meta],
    );
  }

  private async clearIndex(): Promise<void> {
    const schema = quoteIdent(this.schema);
    await this.pool.query(`DELETE FROM ${schema}.memory_files`);
    await this.pool.query(`DELETE FROM ${schema}.memory_chunks`);
    await this.pool.query(`DELETE FROM ${schema}.embedding_cache`);
  }

  private async listSessionFiles(): Promise<string[]> {
    const dir = resolveSessionTranscriptsDirForAgent(this.agentId);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  private sessionPathForFile(absPath: string): string {
    return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
  }

  private buildSessionIdentityMap(): Map<string, SessionIdentity> {
    const storePath = resolveStorePath(this.cfg.session?.store, { agentId: this.agentId });
    const store = loadSessionStore(storePath, { skipCache: true });
    const identities = new Map<string, SessionIdentity>();
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry?.sessionId) {
        continue;
      }
      const sessionFile = resolveSessionFilePath(entry.sessionId, entry, { agentId: this.agentId });
      const channel =
        entry.origin?.provider?.trim() ||
        entry.channel?.trim() ||
        entry.lastChannel?.trim() ||
        undefined;
      const rawUserId =
        entry.origin?.from?.trim() ||
        entry.deliveryContext?.to?.trim() ||
        entry.lastTo?.trim() ||
        undefined;
      const userId =
        channel && rawUserId && !rawUserId.includes(":") ? `${channel}:${rawUserId}` : rawUserId;
      identities.set(sessionFile, {
        sessionKey,
        userId: userId || undefined,
        originLabel: entry.origin?.label?.trim() || undefined,
        channel,
      });
    }
    return identities;
  }

  private normalizeSessionText(value: string): string {
    return value
      .replace(/\s*\n+\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractSessionText(content: unknown): string | null {
    if (typeof content === "string") {
      const normalized = this.normalizeSessionText(content);
      return normalized ? normalized : null;
    }
    if (!Array.isArray(content)) {
      return null;
    }
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const record = block as { type?: unknown; text?: unknown };
      const type = typeof record.type === "string" ? record.type : "";
      if (!["text", "thinking", "reasoning"].includes(type) || typeof record.text !== "string") {
        continue;
      }
      const normalized = this.normalizeSessionText(record.text);
      if (normalized) {
        parts.push(normalized);
      }
    }
    if (parts.length === 0) {
      return null;
    }
    return parts.join(" ");
  }

  private async buildSessionEntry(
    absPath: string,
    identity?: SessionIdentity,
  ): Promise<SessionFileEntry | null> {
    try {
      const stat = await fs.stat(absPath);
      const raw = await fs.readFile(absPath, "utf-8");
      const lines = raw.split("\n");
      const collected: string[] = [];
      const messages: Array<{ role: "user" | "assistant"; text: string; createdAt?: number }> = [];
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          !record ||
          typeof record !== "object" ||
          (record as { type?: unknown }).type !== "message"
        ) {
          continue;
        }
        const message = (record as { message?: unknown }).message as
          | { role?: unknown; content?: unknown; timestamp?: unknown }
          | undefined;
        if (!message || typeof message.role !== "string") {
          continue;
        }
        if (message.role !== "user" && message.role !== "assistant") {
          continue;
        }
        const text = this.extractSessionText(message.content);
        if (!text) {
          continue;
        }
        const label = message.role === "user" ? "User" : "Assistant";
        const timestampRaw =
          (record as { timestamp?: unknown }).timestamp ?? message.timestamp ?? undefined;
        const createdAt =
          typeof timestampRaw === "number"
            ? timestampRaw
            : typeof timestampRaw === "string"
              ? Date.parse(timestampRaw)
              : undefined;
        collected.push(`${label}: ${text}`);
        messages.push({
          role: message.role,
          text,
          createdAt: Number.isFinite(createdAt ?? NaN) ? createdAt : undefined,
        });
      }
      const content = collected.join("\n");
      return {
        path: this.sessionPathForFile(absPath),
        absPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash: hashText(content),
        content,
        messages,
        sessionKey: identity?.sessionKey,
        userId: identity?.userId,
      };
    } catch (err) {
      log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
      return null;
    }
  }

  private async syncMemoryFiles(progress?: MemorySyncProgressState): Promise<void> {
    const workspaceDir = this.workspaceDir;
    const extraPaths = this.settings.extraPaths;
    const files = await listMemoryFiles(workspaceDir, extraPaths);
    const entries = await Promise.all(files.map(async (file) => buildFileEntry(file, workspaceDir)));
    await this.syncEntries(entries, "memory", progress);
  }

  private async syncSessionFiles(progress?: MemorySyncProgressState): Promise<void> {
    const files = await this.listSessionFiles();
    log.debug(`memory sync: syncing ${files.length} session file(s)`);
    const identityMap = this.buildSessionIdentityMap();
    const entries = await Promise.all(
      files.map((file) => this.buildSessionEntry(file, identityMap.get(file))),
    );
    const filtered = entries.filter((entry): entry is SessionFileEntry => Boolean(entry));
    log.debug(`memory sync: processing ${filtered.length} session entry/entries`);
    await this.syncEntries(filtered, "sessions", progress);
    await this.upsertActorDirectory(identityMap);
  }

  private async syncEntries(
    entries: Array<MemoryFileEntry | SessionFileEntry>,
    source: MemorySource,
    progress?: MemorySyncProgressState,
  ): Promise<void> {
    const schema = quoteIdent(this.schema);
    const existing = await this.pool.query(
      `SELECT path, hash FROM ${schema}.memory_files WHERE source = $1`,
      [source],
    );
    const existingByPath = new Map<string, string>(
      existing.rows.map((row) => [row.path as string, row.hash as string]),
    );
    const seen = new Set<string>();
    const tasks: Array<() => Promise<void>> = [];
    for (const entry of entries) {
      seen.add(entry.path);
      const prevHash = existingByPath.get(entry.path);
      if (prevHash && prevHash === entry.hash) {
        continue;
      }
      tasks.push(async () => {
        await this.indexEntry(entry, source);
        progress?.report({ completed: ++progress.completed, total: progress.total, label: entry.path });
      });
    }
    const stale = Array.from(existingByPath.keys()).filter((path) => !seen.has(path));
    for (const pathToDelete of stale) {
      await this.pool.query(
        `DELETE FROM ${schema}.memory_files WHERE path = $1 AND source = $2`,
        [pathToDelete, source],
      );
      await this.pool.query(
        `DELETE FROM ${schema}.memory_chunks WHERE path = $1 AND source = $2`,
        [pathToDelete, source],
      );
    }
    progress && (progress.total += tasks.length);
    for (const task of tasks) {
      await task();
    }
  }

  private async upsertActorDirectory(identityMap: Map<string, SessionIdentity>): Promise<void> {
    if (identityMap.size === 0) {
      return;
    }
    const now = Date.now();
    const actors: Array<{
      actorId: string;
      actorType: string;
      displayName?: string;
      channel?: string;
    }> = [];
    const aliases: Array<{
      alias: string;
      actorId: string;
      source?: string;
      confidence: number;
      channel?: string;
    }> = [];
    for (const identity of identityMap.values()) {
      if (!identity.userId) {
        continue;
      }
      const actorId = identity.userId;
      const channel = identity.channel;
      actors.push({
        actorId,
        actorType: "human",
        displayName: identity.originLabel,
        channel,
      });
      if (identity.originLabel) {
        aliases.push({
          alias: identity.originLabel,
          actorId,
          source: channel ?? "unknown",
          confidence: 1,
          channel,
        });
      }
    }
    if (actors.length === 0) {
      return;
    }
    const schema = quoteIdent(this.schema);
    const actorRows: string[] = [];
    const actorValues: unknown[] = [];
    let idx = 1;
    for (const actor of actors) {
      actorRows.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      actorValues.push(
        actor.actorId,
        actor.actorType,
        actor.displayName ?? null,
        actor.channel ? { channel: actor.channel } : null,
        now,
        now,
      );
    }
    await this.pool.query(
      `INSERT INTO ${schema}.memory_actors ` +
        `(actor_id, actor_type, display_name, metadata, created_at, updated_at)` +
        ` VALUES ${actorRows.join(", ")}` +
        ` ON CONFLICT (actor_id) DO UPDATE SET ` +
        ` actor_type = EXCLUDED.actor_type, ` +
        ` display_name = COALESCE(EXCLUDED.display_name, ${schema}.memory_actors.display_name), ` +
        ` metadata = COALESCE(EXCLUDED.metadata, ${schema}.memory_actors.metadata), ` +
        ` updated_at = EXCLUDED.updated_at`,
      actorValues,
    );
    if (aliases.length === 0) {
      return;
    }
    const aliasRows: string[] = [];
    const aliasValues: unknown[] = [];
    idx = 1;
    for (const alias of aliases) {
      const aliasNorm = alias.alias.trim().toLowerCase();
      if (!aliasNorm) {
        continue;
      }
      aliasRows.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
      );
      aliasValues.push(
        alias.alias,
        aliasNorm,
        alias.actorId,
        alias.source ?? null,
        alias.confidence,
        alias.channel ? { channel: alias.channel } : null,
        now,
        now,
      );
    }
    if (aliasRows.length > 0) {
      await this.pool.query(
        `INSERT INTO ${schema}.memory_actor_aliases ` +
          `(alias, alias_norm, actor_id, source, confidence, metadata, created_at, updated_at)` +
          ` VALUES ${aliasRows.join(", ")}` +
          ` ON CONFLICT (alias_norm, actor_id) DO UPDATE SET ` +
          ` alias = EXCLUDED.alias, source = EXCLUDED.source, confidence = EXCLUDED.confidence, ` +
          ` metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at`,
        aliasValues,
      );
    }
  }

  private async indexEntry(entry: MemoryFileEntry | SessionFileEntry, source: MemorySource) {
    const schema = quoteIdent(this.schema);
    const isSession = source === "sessions" && "messages" in entry;
    log.debug(`memory sync: indexing ${source} entry: ${entry.path} (${isSession ? `${entry.messages?.length || 0} messages` : `${entry.size} bytes`})`);
    const updatedAt = Date.now();
    const sessionKey = isSession ? entry.sessionKey ?? null : null;
    const baseActorId = `agent:${this.agentId}`;
    const baseActorType = "agent";
    const roleForFile = isSession ? null : "system";
    const actorIdForFile = isSession ? null : baseActorId;
    const actorTypeForFile = isSession ? null : baseActorType;
    const content =
      "content" in entry
        ? entry.content
        : await fs.readFile(entry.absPath, "utf-8");
    const chunks: Array<
      MemoryChunk & {
        role: "user" | "assistant" | "system";
        actorType: string;
        actorId: string;
        createdAt?: number;
        messageId?: string;
        messageCreatedAt?: number;
      }
    > = [];
    if (isSession) {
      const userId = entry.userId ?? "unknown";
      for (const message of entry.messages) {
        const role = message.role;
        const actorType = role === "user" ? "human" : "agent";
        const actorId = role === "user" ? userId : baseActorId;
        const messageCreatedAt = Number.isFinite(message.createdAt ?? NaN)
          ? (message.createdAt as number)
          : updatedAt;
        const messageId = randomUUID();
        const messageChunks = chunkMarkdown(message.text, this.settings.chunking);
        for (const chunk of messageChunks) {
          chunks.push({
            ...chunk,
            role,
            actorType,
            actorId,
            createdAt: messageCreatedAt,
            messageId,
            messageCreatedAt,
          });
        }
      }
    } else {
      const fileChunks = chunkMarkdown(content, this.settings.chunking);
      for (const chunk of fileChunks) {
        const createdAt = Math.round(entry.mtimeMs);
        chunks.push({
          ...chunk,
          role: "system",
          actorType: baseActorType,
          actorId: baseActorId,
          createdAt,
        });
      }
    }
    if (chunks.length === 0) {
      log.debug(`memory sync: no chunks to embed for ${entry.path}`);
      return;
    }
    // Check for duplicate chunks before embedding
    const chunkHashes = chunks.map((c) => c.hash);
    const hashCounts = new Map<string, number>();
    for (const hash of chunkHashes) {
      hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
    }
    const duplicateHashes = Array.from(hashCounts.entries()).filter(([, count]) => count > 1);
    if (duplicateHashes.length > 0) {
      log.debug(
        `memory sync: found ${duplicateHashes.length} duplicate hash(es) in ${chunks.length} chunks for ${entry.path}`,
      );
      for (const [hash, count] of duplicateHashes) {
        const matchingChunks = chunks.filter((c) => c.hash === hash);
        const preview = matchingChunks[0]?.text.slice(0, 100) ?? "";
        log.debug(
          `memory sync: hash ${hash.slice(0, 8)}... appears ${count} times, preview: ${preview}...`,
        );
      }
    }
    log.debug(`memory sync: embedding ${chunks.length} chunk(s) for ${entry.path}`);
    // Log chunk previews for debugging
    if (chunks.length > 0) {
      const previews = chunks.slice(0, 10).map((c, i) => {
        const preview = c.text.slice(0, 80).replace(/\n/g, " ");
        return `  [${i}] hash=${c.hash.slice(0, 8)}... role=${c.role} lines=${c.startLine}-${c.endLine}: ${preview}...`;
      });
      log.debug(`memory sync: chunk previews:\n${previews.join("\n")}`);
    }
    const embeddings = await this.embedChunks(chunks);
    if (embeddings.length === 0) {
      return;
    }
    this.vectorDims = embeddings[0]?.length ?? this.vectorDims;
    await this.ensureVectorIndex();
    await this.pool.query("BEGIN");
    try {
      await this.pool.query(
        `INSERT INTO ${schema}.memory_files (path, source, session_key, role, actor_type, actor_id, hash, mtime, size)` +
          ` VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)` +
          ` ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash, mtime = EXCLUDED.mtime, size = EXCLUDED.size,` +
          ` session_key = EXCLUDED.session_key, role = EXCLUDED.role, actor_type = EXCLUDED.actor_type, actor_id = EXCLUDED.actor_id`,
        [
          entry.path,
          source,
          sessionKey,
          roleForFile,
          actorTypeForFile,
          actorIdForFile,
          entry.hash,
          Math.round(entry.mtimeMs),
          entry.size,
        ],
      );
      await this.pool.query(
        `DELETE FROM ${schema}.memory_chunks WHERE path = $1 AND source = $2`,
        [entry.path, source],
      );
      const rows: Array<string> = [];
      const values: unknown[] = [];
      let idx = 1;
      for (const [i, chunk] of chunks.entries()) {
        const embedding = embeddings[i];
        if (!embedding) {
          continue;
        }
        const id = randomUUID();
        rows.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
        );
        values.push(
          id,
          entry.path,
          source,
          sessionKey,
          chunk.role,
          chunk.actorType,
          chunk.actorId,
          chunk.messageId ?? null,
          chunk.messageCreatedAt ?? null,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          vectorLiteral(embedding),
          chunk.createdAt ?? updatedAt,
          updatedAt,
        );
      }
      await this.pool.query(
        `INSERT INTO ${schema}.memory_chunks ` +
          `(id, path, source, session_key, role, actor_type, actor_id, message_id, message_created_at, start_line, end_line, hash, model, text, embedding, created_at, updated_at)` +
          ` VALUES ${rows.join(", ")}`,
        values,
      );
      await this.pool.query("COMMIT");
    } catch (err) {
      await this.pool.query("ROLLBACK");
      throw err;
    }
  }

  private async embedChunks(chunks: MemoryChunk[]): Promise<number[][]> {
    const texts = chunks.map((chunk) => chunk.text);
    if (!this.cache.enabled) {
      return await this.provider.embedBatch(texts);
    }
    const schema = quoteIdent(this.schema);
    const hashes = chunks.map((chunk) => chunk.hash);
    const cached = await this.pool.query(
      `SELECT hash, embedding FROM ${schema}.embedding_cache` +
        ` WHERE provider = $1 AND model = $2 AND provider_key = $3 AND hash = ANY($4)`,
      [this.provider.id, this.provider.model, this.providerKey, hashes],
    );
    const cachedMap = new Map<string, number[]>();
    for (const row of cached.rows as Array<{ hash: string; embedding: unknown }>) {
      if (!row.hash || !row.embedding) {
        continue;
      }
      const embedding = (row.embedding as number[] | string).toString();
      const normalized: string =
        typeof row.embedding === "string"
          ? row.embedding
          : Array.isArray(row.embedding)
            ? `[${row.embedding.join(",")}]`
            : embedding;
      const parsed = normalized
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((value: string) => Number.parseFloat(value))
        .filter((value: number) => Number.isFinite(value));
      if (parsed.length > 0) {
        cachedMap.set(row.hash as string, parsed);
      }
    }
    const missing: Array<{ index: number; text: string; hash: string }> = [];
    const results: number[][] = new Array(chunks.length);
    for (let i = 0; i < chunks.length; i += 1) {
      const hash = chunks[i]?.hash;
      if (!hash) {
        continue;
      }
      const cachedEmbedding = cachedMap.get(hash);
      if (cachedEmbedding) {
        results[i] = cachedEmbedding;
      } else {
        missing.push({ index: i, text: texts[i] ?? "", hash });
      }
    }
    if (missing.length > 0) {
      // Deduplicate texts by hash before calling embedBatch to avoid unnecessary API calls
      const uniqueByHash = new Map<string, { index: number; text: string; hash: string }>();
      const hashToIndices = new Map<string, number[]>();
      const hashToTexts = new Map<string, string[]>();
      for (const entry of missing) {
        if (!uniqueByHash.has(entry.hash)) {
          uniqueByHash.set(entry.hash, entry);
          hashToIndices.set(entry.hash, []);
          hashToTexts.set(entry.hash, []);
        }
        hashToIndices.get(entry.hash)?.push(entry.index);
        hashToTexts.get(entry.hash)?.push(entry.text);
      }
      const uniqueEntries = Array.from(uniqueByHash.values());
      const duplicateCount = missing.length - uniqueEntries.length;
      if (duplicateCount > 0) {
        log.debug(
          `memory embeddings: deduplicated ${duplicateCount} duplicate chunk(s) (${missing.length} -> ${uniqueEntries.length} unique)`,
        );
        // Log which hashes had duplicates
        for (const [hash, indices] of hashToIndices.entries()) {
          if (indices.length > 1) {
            const texts = hashToTexts.get(hash) ?? [];
            const preview = texts[0]?.slice(0, 150) ?? "";
            log.debug(
              `memory embeddings: hash ${hash.slice(0, 12)}... has ${indices.length} duplicate(s), text: ${preview}${preview.length >= 150 ? "..." : ""}`,
            );
          }
        }
      }
      // Also check for near-duplicates (very similar text that might be perceived as duplicates)
      // Group by normalized text (trimmed, lowercased) to find similar chunks
      const normalizedToEntries = new Map<string, Array<{ hash: string; text: string; index: number }>>();
      for (const entry of missing) {
        const normalized = entry.text.trim().toLowerCase();
        if (!normalizedToEntries.has(normalized)) {
          normalizedToEntries.set(normalized, []);
        }
        normalizedToEntries.get(normalized)?.push({ hash: entry.hash, text: entry.text, index: entry.index });
      }
      for (const [normalized, entries] of normalizedToEntries.entries()) {
        if (entries.length > 1) {
          const uniqueHashes = new Set(entries.map((e) => e.hash));
          if (uniqueHashes.size === 1) {
            // Same hash - should have been deduplicated, this is a bug
            log.debug(
              `memory embeddings: WARNING - ${entries.length} entries with identical normalized text and hash ${entries[0]?.hash.slice(0, 12)}... (should be deduplicated)`,
            );
          } else {
            // Different hashes but same normalized text - might be whitespace differences
            const preview = entries[0]?.text.slice(0, 150) ?? "";
            log.debug(
              `memory embeddings: ${entries.length} entries with similar normalized text but ${uniqueHashes.size} different hash(es), preview: ${preview}${preview.length >= 150 ? "..." : ""}`,
            );
          }
        }
      }
      log.debug(`memory embeddings: calling embedBatch with ${uniqueEntries.length} unique text(s) (from ${missing.length} missing chunks)`);
      const embeddings = await this.provider.embedBatch(uniqueEntries.map((entry) => entry.text));
      const now = Date.now();
      const rows: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      const cacheHashesSeen = new Set<string>();
      for (const [i, entry] of uniqueEntries.entries()) {
        const embedding = embeddings[i];
        if (!embedding) {
          continue;
        }
        // Assign the same embedding to all chunks with this hash
        const indices = hashToIndices.get(entry.hash) ?? [];
        for (const index of indices) {
          results[index] = embedding;
        }
        if (cacheHashesSeen.has(entry.hash)) {
          continue;
        }
        cacheHashesSeen.add(entry.hash);
        rows.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
        );
        values.push(
          this.provider.id,
          this.provider.model,
          this.providerKey,
          entry.hash,
          vectorLiteral(embedding),
          embedding.length,
          now,
        );
      }
      if (rows.length > 0) {
        await this.pool.query(
          `INSERT INTO ${schema}.embedding_cache` +
            ` (provider, model, provider_key, hash, embedding, dims, updated_at)` +
            ` VALUES ${rows.join(", ")}` +
            ` ON CONFLICT (provider, model, provider_key, hash)` +
            ` DO UPDATE SET embedding = EXCLUDED.embedding, dims = EXCLUDED.dims, updated_at = EXCLUDED.updated_at`,
          values,
        );
      }
    }
    const finalized = results.map((value) => value ?? []);
    if (finalized.some((value) => value.length === 0)) {
      throw new Error("Embedding provider returned empty embeddings.");
    }
    return finalized;
  }

  private async ensureVectorIndex(): Promise<void> {
    if (!this.vectorDims || !this.settings.store.vector.enabled) {
      return;
    }
    const schema = quoteIdent(this.schema);
    const indexName = quoteIdent(`memory_chunks_vec_${this.vectorDims}`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${schema}.memory_chunks ` +
        ` USING hnsw ((embedding::vector(${this.vectorDims})) vector_cosine_ops);`,
    );
  }

  private async refreshCounts(): Promise<void> {
    const schema = quoteIdent(this.schema);
    const sources = Array.from(this.sources);
    const sourceCounts = sources.map((source) => ({ source, files: 0, chunks: 0 }));
    const filesResult = await this.pool.query(
      `SELECT source, COUNT(*)::int AS c FROM ${schema}.memory_files WHERE source = ANY($1) GROUP BY source`,
      [sources],
    );
    for (const row of filesResult.rows as Array<{ source: MemorySource; c: number }>) {
      const entry = sourceCounts.find((item) => item.source === row.source);
      if (entry) {
        entry.files = Number(row.c ?? 0);
      }
    }
    const chunksResult = await this.pool.query(
      `SELECT source, COUNT(*)::int AS c FROM ${schema}.memory_chunks WHERE source = ANY($1) GROUP BY source`,
      [sources],
    );
    for (const row of chunksResult.rows as Array<{ source: MemorySource; c: number }>) {
      const entry = sourceCounts.find((item) => item.source === row.source);
      if (entry) {
        entry.chunks = Number(row.c ?? 0);
      }
    }
    let cacheEntries: number | undefined;
    if (this.cache.enabled) {
      const cacheResult = await this.pool.query(
        `SELECT COUNT(*)::int AS c FROM ${schema}.embedding_cache`,
      );
      cacheEntries = Number(cacheResult.rows[0]?.c ?? 0);
    }
    const filesTotal = sourceCounts.reduce((acc, entry) => acc + entry.files, 0);
    const chunksTotal = sourceCounts.reduce((acc, entry) => acc + entry.chunks, 0);
    this.lastCounts = { files: filesTotal, chunks: chunksTotal, sourceCounts, cacheEntries };
  }

  private buildSearchFilters(params: {
    startIndex: number;
    sessionKey?: string;
    sessionScope?: "session" | "actor" | "global";
    actorId?: string;
    actorType?: string;
    role?: string;
    updatedAfter?: number;
    updatedBefore?: number;
  }): { sql: string; params: unknown[]; nextIndex: number } {
    const sqlParts: string[] = [];
    const values: unknown[] = [];
    let idx = params.startIndex;
    const scope = params.sessionScope ?? "session";
    const actorId = params.actorId?.trim();
    const actorType = params.actorType?.trim();
    const role = params.role?.trim();

    if (scope === "session" && params.sessionKey) {
      // For session-scoped searches, ONLY include session transcripts (exclude memory files)
      // This prevents private memory files from leaking into group chats or other sessions
      sqlParts.push(` AND source = 'sessions' AND session_key = $${idx}`);
      values.push(params.sessionKey);
      idx += 1;
    }

    if (scope === "actor" && (actorId || actorType)) {
      const clauses: string[] = [];
      if (actorId) {
        clauses.push(`actor_id = $${idx}`);
        values.push(actorId);
        idx += 1;
      }
      if (actorType) {
        clauses.push(`actor_type = $${idx}`);
        values.push(actorType);
        idx += 1;
      }
      if (clauses.length > 0) {
        sqlParts.push(` AND (source <> 'sessions' OR (${clauses.join(" AND ")}))`);
      }
    } else {
      if (actorId) {
        sqlParts.push(` AND actor_id = $${idx}`);
        values.push(actorId);
        idx += 1;
      }
      if (actorType) {
        sqlParts.push(` AND actor_type = $${idx}`);
        values.push(actorType);
        idx += 1;
      }
    }

    if (role) {
      sqlParts.push(` AND role = $${idx}`);
      values.push(role);
      idx += 1;
    }

    if (typeof params.updatedAfter === "number" && Number.isFinite(params.updatedAfter)) {
      sqlParts.push(` AND COALESCE(created_at, updated_at) >= $${idx}`);
      values.push(Math.floor(params.updatedAfter));
      idx += 1;
    }
    if (typeof params.updatedBefore === "number" && Number.isFinite(params.updatedBefore)) {
      sqlParts.push(` AND COALESCE(created_at, updated_at) <= $${idx}`);
      values.push(Math.floor(params.updatedBefore));
      idx += 1;
    }

    return {
      sql: sqlParts.join(""),
      params: values,
      nextIndex: idx,
    };
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
    filters?: {
      sessionKey?: string;
      sessionScope?: "session" | "actor" | "global";
      actorId?: string;
      actorType?: string;
      role?: string;
      updatedAfter?: number;
      updatedBefore?: number;
    },
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    if (queryVec.length === 0) {
      return [];
    }
    const schema = quoteIdent(this.schema);
    const dims = queryVec.length;
    const sources = Array.from(this.sources);
    const params: unknown[] = [vectorLiteral(queryVec), this.provider.model, sources];
    const { sql: filterSql, params: filterParams, nextIndex } = this.buildSearchFilters({
      startIndex: 4,
      sessionKey: filters?.sessionKey,
      sessionScope: filters?.sessionScope,
      actorId: filters?.actorId,
      actorType: filters?.actorType,
      role: filters?.role,
      updatedAfter: filters?.updatedAfter,
      updatedBefore: filters?.updatedBefore,
    });
    params.push(...filterParams);
    params.push(limit);
    const limitParam = `$${nextIndex}`;
    const rows = await this.pool.query(
      `SELECT id, path, source, start_line, end_line, text,` +
        ` 1 - (embedding <=> $1::vector(${dims})) AS score` +
        ` FROM ${schema}.memory_chunks` +
        ` WHERE model = $2 AND source = ANY($3)${filterSql}` +
        ` ORDER BY embedding <=> $1::vector(${dims}) ASC` +
        ` LIMIT ${limitParam}`,
      params,
    );
    return (rows.rows as Array<{
      id: string;
      path: string;
      source: MemorySource;
      start_line: number;
      end_line: number;
      text: string;
      score: number;
    }>).map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: Number(row.score ?? 0),
      snippet: truncateUtf16Safe(String(row.text ?? ""), SNIPPET_MAX_CHARS),
      source: row.source,
    }));
  }

  private async searchKeyword(
    query: string,
    limit: number,
    filters?: {
      sessionKey?: string;
      sessionScope?: "session" | "actor" | "global";
      actorId?: string;
      actorType?: string;
      role?: string;
      updatedAfter?: number;
      updatedBefore?: number;
    },
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (limit <= 0) {
      return [];
    }
    const schema = quoteIdent(this.schema);
    const sources = Array.from(this.sources);
    const params: unknown[] = [query, this.provider.model, sources];
    const { sql: filterSql, params: filterParams, nextIndex } = this.buildSearchFilters({
      startIndex: 4,
      sessionKey: filters?.sessionKey,
      sessionScope: filters?.sessionScope,
      actorId: filters?.actorId,
      actorType: filters?.actorType,
      role: filters?.role,
      updatedAfter: filters?.updatedAfter,
      updatedBefore: filters?.updatedBefore,
    });
    params.push(...filterParams);
    params.push(limit);
    const limitParam = `$${nextIndex}`;
    const rows = await this.pool.query(
      `SELECT id, path, source, start_line, end_line, text,` +
        ` ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) AS rank` +
        ` FROM ${schema}.memory_chunks` +
        ` WHERE text_tsv @@ plainto_tsquery('english', $1)` +
        ` AND model = $2 AND source = ANY($3)${filterSql}` +
        ` ORDER BY rank DESC` +
        ` LIMIT ${limitParam}`,
      params,
    );
    return (rows.rows as Array<{
      id: string;
      path: string;
      source: MemorySource;
      start_line: number;
      end_line: number;
      text: string;
      rank: number;
    }>).map((row) => {
      const textScore = Number(row.rank ?? 0);
      return {
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: textScore,
        textScore,
        snippet: truncateUtf16Safe(String(row.text ?? ""), SNIPPET_MAX_CHARS),
        source: row.source,
      };
    });
  }

  /**
   * Get the most recent N messages from a session, grouped by message_id.
   * Returns messages ordered by message_created_at DESC (newest first).
   */
  async getRecentMessages(params: {
    sessionKey: string;
    limit?: number;
  }): Promise<
    Array<{
      messageId: string;
      role: "user" | "assistant" | "system";
      text: string;
      messageCreatedAt: number;
      actorId: string;
      actorType: string;
    }>
  > {
    const schema = quoteIdent(this.schema);
    const limit = params.limit ?? this.settings.recentWindowMessages ?? 10;
    if (limit <= 0) {
      return [];
    }
    // Get the most recent N distinct message_ids using a subquery
    const messageRows = await this.pool.query(
      `SELECT DISTINCT message_id, MAX(message_created_at) as max_created_at` +
        ` FROM ${schema}.memory_chunks` +
        ` WHERE session_key = $1 AND message_id IS NOT NULL AND message_created_at IS NOT NULL` +
        ` GROUP BY message_id` +
        ` ORDER BY max_created_at DESC` +
        ` LIMIT $2`,
      [params.sessionKey, limit],
    );
    if (messageRows.rows.length === 0) {
      return [];
    }
    // Get all chunks for these messages, ordered by start_line
    const messageIds = messageRows.rows.map((r) => r.message_id);
    const chunkRows = await this.pool.query(
      `SELECT message_id, text, start_line, role, message_created_at, actor_id, actor_type` +
        ` FROM ${schema}.memory_chunks` +
        ` WHERE message_id = ANY($1)` +
        ` ORDER BY message_created_at DESC, start_line ASC`,
      [messageIds],
    );
    // Group chunks by message_id and reconstruct full message text
    const messageMap = new Map<
      string,
      {
        messageId: string;
        role: "user" | "assistant" | "system";
        text: string;
        messageCreatedAt: number;
        actorId: string;
        actorType: string;
      }
    >();
    for (const row of chunkRows.rows) {
      const msgId = String(row.message_id ?? "");
      if (!msgId) {
        continue;
      }
      const existing = messageMap.get(msgId);
      if (existing) {
        existing.text += row.text ?? "";
      } else {
        messageMap.set(msgId, {
          messageId: msgId,
          role: (row.role ?? "system") as "user" | "assistant" | "system",
          text: String(row.text ?? ""),
          messageCreatedAt: Number(row.message_created_at ?? 0),
          actorId: String(row.actor_id ?? ""),
          actorType: String(row.actor_type ?? ""),
        });
      }
    }
    // Return in DESC order (newest first)
    return Array.from(messageMap.values()).sort(
      (a, b) => b.messageCreatedAt - a.messageCreatedAt,
    );
  }
}

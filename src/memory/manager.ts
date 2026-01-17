import fs from "node:fs/promises";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";

import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { resolveUserPath, truncateUtf16Safe } from "../utils.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
} from "./embeddings.js";
import {
  buildFileEntry,
  chunkMarkdown,
  cosineSimilarity,
  ensureDir,
  hashText,
  isMemoryPath,
  listMemoryFiles,
  type MemoryFileEntry,
  normalizeRelPath,
  parseEmbedding,
} from "./internal.js";
import { requireNodeSqlite } from "./sqlite.js";

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
};

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const SESSION_DIRTY_DEBOUNCE_MS = 5000;

const log = createSubsystemLogger("memory");

const INDEX_CACHE = new Map<string, MemoryIndexManager>();

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export class MemoryIndexManager {
  private readonly cacheKey: string;
  private readonly cfg: ClawdbotConfig;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly settings: ResolvedMemorySearchConfig;
  private readonly provider: EmbeddingProvider;
  private readonly requestedProvider: "openai" | "local";
  private readonly fallbackReason?: string;
  private readonly db: DatabaseSync;
  private readonly sources: Set<MemorySource>;
  private readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  private vectorReady: Promise<boolean> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private sessionWatchTimer: NodeJS.Timeout | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private dirty = false;
  private sessionsDirty = false;
  private sessionsDirtyFiles = new Set<string>();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;

  static async get(params: {
    cfg: ClawdbotConfig;
    agentId: string;
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) return null;
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
    const existing = INDEX_CACHE.get(key);
    if (existing) return existing;
    const providerResult = await createEmbeddingProvider({
      config: cfg,
      agentDir: resolveAgentDir(cfg, agentId),
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      fallback: settings.fallback,
      local: settings.local,
    });
    const manager = new MemoryIndexManager({
      cacheKey: key,
      cfg,
      agentId,
      workspaceDir,
      settings,
      providerResult,
    });
    INDEX_CACHE.set(key, manager);
    return manager;
  }

  private constructor(params: {
    cacheKey: string;
    cfg: ClawdbotConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult: EmbeddingProviderResult;
  }) {
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.ensureSchema();
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: null,
      extensionPath: params.settings.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    this.ensureWatcher();
    this.ensureSessionListener();
    this.ensureIntervalSync();
    this.dirty = this.sources.has("memory");
    if (this.sources.has("sessions")) {
      this.sessionsDirty = true;
    }
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) return;
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) return;
    await this.sync({ reason: "session-start" });
    if (key) this.sessionWarm.add(key);
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    await this.warmSession(opts?.sessionKey);
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
      await this.sync({ reason: "search" });
    }
    const cleaned = query.trim();
    if (!cleaned) return [];
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const queryVec = await this.provider.embedQuery(cleaned);
    if (queryVec.length === 0) return [];
    if (await this.ensureVectorReady(queryVec.length)) {
      const sourceFilter = this.buildSourceFilter("c");
      const rows = this.db
        .prepare(
          `SELECT c.path, c.start_line, c.end_line, c.text,
                  c.source,
                  vec_distance_cosine(v.embedding, ?) AS dist
             FROM ${VECTOR_TABLE} v
             JOIN chunks c ON c.id = v.id
            WHERE c.model = ?${sourceFilter.sql}
            ORDER BY dist ASC
            LIMIT ?`,
        )
        .all(
          vectorToBlob(queryVec),
          this.provider.model,
          ...sourceFilter.params,
          maxResults,
        ) as Array<{
        path: string;
        start_line: number;
        end_line: number;
        text: string;
        source: MemorySource;
        dist: number;
      }>;
      return rows
        .map((row) => ({
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          score: 1 - row.dist,
          snippet: truncateUtf16Safe(row.text, SNIPPET_MAX_CHARS),
          source: row.source,
        }))
        .filter((entry) => entry.score >= minScore);
    }
    const candidates = this.listChunks();
    const scored = candidates
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryVec, chunk.embedding),
      }))
      .filter((entry) => Number.isFinite(entry.score));
    return scored
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((entry) => ({
        path: entry.chunk.path,
        startLine: entry.chunk.startLine,
        endLine: entry.chunk.endLine,
        score: entry.score,
        snippet: truncateUtf16Safe(entry.chunk.text, SNIPPET_MAX_CHARS),
        source: entry.chunk.source,
      }));
  }

  async sync(params?: { reason?: string; force?: boolean }): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const relPath = normalizeRelPath(params.relPath);
    if (!relPath || !isMemoryPath(relPath)) {
      throw new Error("path required");
    }
    const absPath = path.resolve(this.workspaceDir, relPath);
    if (!absPath.startsWith(this.workspaceDir)) {
      throw new Error("path escapes workspace");
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
    fallback?: { from: string; reason?: string };
    vector?: {
      enabled: boolean;
      available?: boolean;
      extensionPath?: string;
      loadError?: string;
      dims?: number;
    };
  } {
    const sourceFilter = this.buildSourceFilter();
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    return {
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: this.provider.id,
      model: this.provider.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      fallback: this.fallbackReason ? { from: "local", reason: this.fallbackReason } : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }

  private async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) return false;
    if (!this.vectorReady) {
      this.vectorReady = this.loadVectorExtension();
    }
    const ready = await this.vectorReady;
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) return this.vector.available;
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const sqliteVec = await import("sqlite-vec");
      const extensionPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : sqliteVec.getLoadablePath();
      this.db.enableLoadExtension(true);
      if (this.vector.extensionPath?.trim()) {
        this.db.loadExtension(extensionPath);
      } else {
        sqliteVec.load(this.db);
      }
      this.vector.extensionPath = extensionPath;
      this.vector.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions) return;
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  private buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) return { sql: "", params: [] };
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  private ensureColumn(table: "files" | "chunks", column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path);
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = requireNodeSqlite();
    return new DatabaseSync(dbPath, { allowExtension: this.settings.store.vector.enabled });
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ensureColumn("files", "source", "TEXT NOT NULL DEFAULT 'memory'");
    this.ensureColumn("chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);
  }

  private ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) return;
    const watchPaths = [
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory"),
    ];
    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.settings.sync.watchDebounceMs,
        pollInterval: 100,
      },
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  private ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) return;
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) return;
      const sessionFile = update.sessionFile;
      if (!this.isSessionFileForAgent(sessionFile)) return;
      this.scheduleSessionDirty(sessionFile);
    });
  }

  private scheduleSessionDirty(sessionFile: string) {
    this.sessionsDirtyFiles.add(sessionFile);
    if (this.sessionWatchTimer) return;
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      this.sessionsDirty = true;
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) return false;
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
    const resolvedFile = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  private ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) return;
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        log.warn(`memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`memory sync failed (watch): ${String(err)}`);
      });
    }, this.settings.sync.watchDebounceMs);
  }

  private listChunks(): Array<{
    path: string;
    startLine: number;
    endLine: number;
    text: string;
    embedding: number[];
    source: MemorySource;
  }> {
    const sourceFilter = this.buildSourceFilter();
    const rows = this.db
      .prepare(
        `SELECT path, start_line, end_line, text, embedding, source
           FROM chunks
          WHERE model = ?${sourceFilter.sql}`,
      )
      .all(this.provider.model, ...sourceFilter.params) as Array<{
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
      source: MemorySource;
    }>;
    return rows.map((row) => ({
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      embedding: parseEmbedding(row.embedding),
      source: row.source,
    }));
  }

  private shouldSyncSessions(params?: { reason?: string; force?: boolean }, needsFullReindex = false) {
    if (!this.sources.has("sessions")) return false;
    if (params?.force) return true;
    const reason = params?.reason;
    if (reason === "session-start" || reason === "watch") return false;
    return this.sessionsDirty || needsFullReindex;
  }

  private async syncMemoryFiles(params: { needsFullReindex: boolean }) {
    const files = await listMemoryFiles(this.workspaceDir);
    const fileEntries = await Promise.all(
      files.map(async (file) => buildFileEntry(file, this.workspaceDir)),
    );
    const activePaths = new Set(fileEntries.map((entry) => entry.path));

    for (const entry of fileEntries) {
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        continue;
      }
      await this.indexFile(entry, { source: "memory" });
    }

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("memory") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) continue;
      this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(stale.path, "memory");
      this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(stale.path, "memory");
    }
  }

  private async syncSessionFiles(params: { needsFullReindex: boolean }) {
    const files = await this.listSessionFiles();
    const activePaths = new Set(files.map((file) => this.sessionPathForFile(file)));
    const indexAll = params.needsFullReindex || this.sessionsDirtyFiles.size === 0;

    for (const absPath of files) {
      if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) continue;
      const entry = await this.buildSessionEntry(absPath);
      if (!entry) continue;
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "sessions") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        continue;
      }
      await this.indexFile(entry, { source: "sessions", content: entry.content });
    }

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("sessions") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) continue;
      this.db
        .prepare(`DELETE FROM files WHERE path = ? AND source = ?`)
        .run(stale.path, "sessions");
      this.db
        .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
        .run(stale.path, "sessions");
    }
  }

  private async runSync(params?: { reason?: string; force?: boolean }) {
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const needsFullReindex =
      params?.force ||
      !meta ||
      meta.model !== this.provider.model ||
      meta.provider !== this.provider.id ||
      meta.chunkTokens !== this.settings.chunking.tokens ||
      meta.chunkOverlap !== this.settings.chunking.overlap ||
      (vectorReady && !meta?.vectorDims);
    if (needsFullReindex) {
      this.resetIndex();
    }

    const shouldSyncMemory =
      this.sources.has("memory") && (params?.force || needsFullReindex || this.dirty);
    const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

    if (shouldSyncMemory) {
      await this.syncMemoryFiles({ needsFullReindex });
      this.dirty = false;
    }

    if (shouldSyncSessions) {
      await this.syncSessionFiles({ needsFullReindex });
      this.sessionsDirty = false;
      this.sessionsDirtyFiles.clear();
    } else if (needsFullReindex && this.sources.has("sessions")) {
      this.sessionsDirty = true;
    }

    const nextMeta: MemoryIndexMeta = {
      model: this.provider.model,
      provider: this.provider.id,
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
    };
    if (this.vector.available && this.vector.dims) {
      nextMeta.vectorDims = this.vector.dims;
    }
    if (shouldSyncMemory || shouldSyncSessions || needsFullReindex) {
      this.writeMeta(nextMeta);
    }
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
    this.dropVectorTable();
    this.vector.dims = undefined;
    this.sessionsDirtyFiles.clear();
  }

  private readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as MemoryIndexMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
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

  private normalizeSessionText(value: string): string {
    return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
  }

  private extractSessionText(content: unknown): string | null {
    if (typeof content === "string") {
      const normalized = this.normalizeSessionText(content);
      return normalized ? normalized : null;
    }
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as { type?: unknown; text?: unknown };
      if (record.type !== "text" || typeof record.text !== "string") continue;
      const normalized = this.normalizeSessionText(record.text);
      if (normalized) parts.push(normalized);
    }
    if (parts.length === 0) return null;
    return parts.join(" ");
  }

  private async buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
    try {
      const stat = await fs.stat(absPath);
      const raw = await fs.readFile(absPath, "utf-8");
      const lines = raw.split("\n");
      const collected: string[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
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
          | { role?: unknown; content?: unknown }
          | undefined;
        if (!message || typeof message.role !== "string") continue;
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = this.extractSessionText(message.content);
        if (!text) continue;
        const label = message.role === "user" ? "User" : "Assistant";
        collected.push(`${label}: ${text}`);
      }
      const content = collected.join("\n");
      return {
        path: this.sessionPathForFile(absPath),
        absPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash: hashText(content),
        content,
      };
    } catch (err) {
      log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
      return null;
    }
  }

  private async indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ) {
    const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
    const chunks = chunkMarkdown(content, this.settings.chunking);
    const embeddings = await this.provider.embedBatch(chunks.map((chunk) => chunk.text));
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();
    this.db
      .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
      .run(entry.path, options.source);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const id = hashText(
        `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at`,
        )
        .run(
          id,
          entry.path,
          options.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
        );
      if (vectorReady && embedding.length > 0) {
        this.db
          .prepare(`INSERT OR REPLACE INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(id, vectorToBlob(embedding));
      }
    }
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`,
      )
      .run(entry.path, options.source, entry.hash, entry.mtimeMs, entry.size);
  }
}

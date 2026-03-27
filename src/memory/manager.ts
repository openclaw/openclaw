import type { DatabaseSync } from "node:sqlite";
import { type FSWatcher } from "chokidar";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import { extractKeywords } from "./query-expansion.js";
import { readMemoryFile } from "./read-file.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const BATCH_FAILURE_LIMIT = 2;

const MEMORY_INDEX_MANAGER_CACHE_KEY = Symbol.for("openclaw.memoryIndexManagerCache");
type MemoryIndexManagerCacheStore = {
  indexCache: Map<string, MemoryIndexManager>;
  indexCachePending: Map<string, Promise<MemoryIndexManager>>;
};

function getMemoryIndexManagerCacheStore(): MemoryIndexManagerCacheStore {
  // Keep manager caches reachable across `vi.resetModules()` so cleanup still reaches older managers.
  return resolveGlobalSingleton<MemoryIndexManagerCacheStore>(
    MEMORY_INDEX_MANAGER_CACHE_KEY,
    () => ({
      indexCache: new Map<string, MemoryIndexManager>(),
      indexCachePending: new Map<string, Promise<MemoryIndexManager>>(),
    }),
  );
}

const log = createSubsystemLogger("memory");

const { indexCache: INDEX_CACHE, indexCachePending: INDEX_CACHE_PENDING } =
  getMemoryIndexManagerCacheStore();

export async function closeAllMemoryIndexManagers(): Promise<void> {
  const pending = Array.from(INDEX_CACHE_PENDING.values());
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  const managers = Array.from(INDEX_CACHE.values());
  INDEX_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close();
    } catch (err) {
      log.warn(`failed to close memory index manager: ${String(err)}`);
    }
  }
}

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey: string;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null;
  private readonly requestedProvider: EmbeddingProviderRequest;
  private providerInitPromise: Promise<void> | null = null;
  private providerInitialized = false;
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
  protected fallbackReason?: string;
  private providerUnavailableReason?: string;
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  protected ollama?: OllamaEmbeddingClient;
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0;
  protected batchFailureLastError?: string;
  protected batchFailureLastProvider?: string;
  protected batchFailureLock: Promise<void> = Promise.resolve();
  protected db: DatabaseSync;
  protected readonly sources: Set<MemorySource>;
  protected providerKey: string;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  protected sessionsDirty = false;
  protected sessionsDirtyFiles = new Set<string>();
  protected sessionPendingFiles = new Set<string>();
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;
  private queuedSessionFiles = new Set<string>();
  private queuedSessionSync: Promise<void> | null = null;
  private readonlyRecoveryAttempts = 0;
  private readonlyRecoverySuccesses = 0;
  private readonlyRecoveryFailures = 0;
  private readonlyRecoveryLastError?: string;

  private static async loadProviderResult(params: {
    cfg: OpenClawConfig;
    agentId: string;
    settings: ResolvedMemorySearchConfig;
  }): Promise<EmbeddingProviderResult> {
    return await createEmbeddingProvider({
      config: params.cfg,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      provider: params.settings.provider,
      remote: params.settings.remote,
      model: params.settings.model,
      outputDimensionality: params.settings.outputDimensionality,
      fallback: params.settings.fallback,
      local: params.settings.local,
    });
  }

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const purpose = params.purpose === "status" ? "status" : "default";
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}:${purpose}`;
    const statusOnly = params.purpose === "status";
    if (statusOnly) {
      return new MemoryIndexManager({
        cacheKey: key,
        cfg,
        agentId,
        workspaceDir,
        settings,
        purpose: params.purpose,
      });
    }
    const existing = INDEX_CACHE.get(key);
    if (existing) {
      return existing;
    }
    const pending = INDEX_CACHE_PENDING.get(key);
    if (pending) {
      return pending;
    }
    const createPromise = (async () => {
      const refreshed = INDEX_CACHE.get(key);
      if (refreshed) {
        return refreshed;
      }
      const manager = new MemoryIndexManager({
        cacheKey: key,
        cfg,
        agentId,
        workspaceDir,
        settings,
        purpose: params.purpose,
      });
      INDEX_CACHE.set(key, manager);
      return manager;
    })();
    INDEX_CACHE_PENDING.set(key, createPromise);
    try {
      return await createPromise;
    } finally {
      if (INDEX_CACHE_PENDING.get(key) === createPromise) {
        INDEX_CACHE_PENDING.delete(key);
      }
    }
  }

  private constructor(params: {
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult?: EmbeddingProviderResult;
    purpose?: "default" | "status";
  }) {
    super();
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = null;
    this.requestedProvider = params.settings.provider;
    if (params.providerResult) {
      this.applyProviderResult(params.providerResult);
    }
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.providerKey = this.computeProviderKey();
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.fts = { enabled: params.settings.query.hybrid.enabled, available: false };
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
    const statusOnly = params.purpose === "status";
    if (!statusOnly) {
      this.ensureWatcher();
      this.ensureSessionListener();
      this.ensureIntervalSync();
    }
    this.dirty = this.sources.has("memory") && (statusOnly ? !meta : true);
    this.batch = this.resolveBatchConfig();
  }

  private applyProviderResult(providerResult: EmbeddingProviderResult): void {
    this.provider = providerResult.provider;
    this.fallbackFrom = providerResult.fallbackFrom;
    this.fallbackReason = providerResult.fallbackReason;
    this.providerUnavailableReason = providerResult.providerUnavailableReason;
    this.openAi = providerResult.openAi;
    this.gemini = providerResult.gemini;
    this.voyage = providerResult.voyage;
    this.mistral = providerResult.mistral;
    this.ollama = providerResult.ollama;
    this.providerInitialized = true;
  }

  private async ensureProviderInitialized(): Promise<void> {
    if (this.providerInitialized) {
      return;
    }
    if (!this.providerInitPromise) {
      this.providerInitPromise = (async () => {
        const providerResult = await MemoryIndexManager.loadProviderResult({
          cfg: this.cfg,
          agentId: this.agentId,
          settings: this.settings,
        });
        this.applyProviderResult(providerResult);
        this.providerKey = this.computeProviderKey();
        this.batch = this.resolveBatchConfig();
      })();
    }
    try {
      await this.providerInitPromise;
    } finally {
      if (this.providerInitialized) {
        this.providerInitPromise = null;
      }
    }
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    void this.warmSession(opts?.sessionKey);
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      });
    }
    const hasIndexedContent = this.hasIndexedContent();
    if (!hasIndexedContent) {
      return [];
    }
    await this.ensureProviderInitialized();
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    // FTS-only mode: no embedding provider available
    if (!this.provider) {
      if (!this.fts.enabled || !this.fts.available) {
        log.warn("memory search: no provider and FTS unavailable");
        return [];
      }

      // Extract keywords for better FTS matching on conversational queries
      // e.g., "that thing we discussed about the API" → ["discussed", "API"]
      const keywords = extractKeywords(cleaned);
      const searchTerms = keywords.length > 0 ? keywords : [cleaned];

      // Search with each keyword and merge results
      const resultSets = await Promise.all(
        searchTerms.map((term) => this.searchKeyword(term, candidates).catch(() => [])),
      );

      // Merge and deduplicate results, keeping highest score for each chunk
      const seenIds = new Map<string, (typeof resultSets)[0][0]>();
      for (const results of resultSets) {
        for (const result of results) {
          const existing = seenIds.get(result.id);
          if (!existing || result.score > existing.score) {
            seenIds.set(result.id, result);
          }
        }
      }

      const merged = [...seenIds.values()]
        .toSorted((a, b) => b.score - a.score)
        .filter((entry) => entry.score >= minScore)
        .slice(0, maxResults);

      return merged;
    }

    // If FTS isn't available, hybrid mode cannot use keyword search; degrade to vector-only.
    const keywordResults =
      hybrid.enabled && this.fts.enabled && this.fts.available
        ? await this.searchKeyword(cleaned, candidates).catch(() => [])
        : [];

    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];

    if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const merged = await this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
    });
    const strict = merged.filter((entry) => entry.score >= minScore);
    if (strict.length > 0 || keywordResults.length === 0) {
      return strict.slice(0, maxResults);
    }

    // Hybrid defaults can produce keyword-only matches with max score equal to
    // textWeight (for example 0.3). If minScore is higher (for example 0.35),
    // these exact lexical hits get filtered out even when they are the only
    // relevant results.
    const relaxedMinScore = Math.min(minScore, hybrid.textWeight);
    const keywordKeys = new Set(
      keywordResults.map(
        (entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`,
      ),
    );
    return merged
      .filter(
        (entry) =>
          keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`) &&
          entry.score >= relaxedMinScore,
      )
      .slice(0, maxResults);
  }

  private hasIndexedContent(): boolean {
    const chunkRow = this.db.prepare(`SELECT 1 as found FROM chunks LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    if (chunkRow?.found === 1) {
      return true;
    }
    if (!this.fts.enabled || !this.fts.available) {
      return false;
    }
    const ftsRow = this.db.prepare(`SELECT 1 as found FROM ${FTS_TABLE} LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    return ftsRow?.found === 1;
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    // This method should never be called without a provider
    if (!this.provider) {
      return [];
    }
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter();
    // In FTS-only mode (no provider), search all models; otherwise filter by current provider's model
    const providerModel = this.provider?.model;
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
  }): Promise<MemorySearchResult[]> {
    return mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    }).then((entries) => entries.map((entry) => entry as MemorySearchResult));
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.ensureProviderInitialized();
    if (this.syncing) {
      if (params?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
        return this.enqueueTargetedSessionSync(params.sessionFiles);
      }
      return this.syncing;
    }
    this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  private enqueueTargetedSessionSync(sessionFiles?: string[]): Promise<void> {
    for (const sessionFile of sessionFiles ?? []) {
      const trimmed = sessionFile.trim();
      if (trimmed) {
        this.queuedSessionFiles.add(trimmed);
      }
    }
    if (this.queuedSessionFiles.size === 0) {
      return this.syncing ?? Promise.resolve();
    }
    if (!this.queuedSessionSync) {
      this.queuedSessionSync = (async () => {
        try {
          await this.syncing?.catch(() => undefined);
          while (!this.closed && this.queuedSessionFiles.size > 0) {
            const queuedSessionFiles = Array.from(this.queuedSessionFiles);
            this.queuedSessionFiles.clear();
            await this.sync({
              reason: "queued-session-files",
              sessionFiles: queuedSessionFiles,
            });
          }
        } finally {
          this.queuedSessionSync = null;
        }
      })();
    }
    return this.queuedSessionSync;
  }

  private isReadonlyDbError(err: unknown): boolean {
    const readonlyPattern =
      /attempt to write a readonly database|database is read-only|SQLITE_READONLY/i;
    const messages = new Set<string>();

    const pushValue = (value: unknown): void => {
      if (typeof value !== "string") {
        return;
      }
      const normalized = value.trim();
      if (!normalized) {
        return;
      }
      messages.add(normalized);
    };

    pushValue(err instanceof Error ? err.message : String(err));
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      pushValue(record.message);
      pushValue(record.code);
      pushValue(record.name);
      if (record.cause && typeof record.cause === "object") {
        const cause = record.cause as Record<string, unknown>;
        pushValue(cause.message);
        pushValue(cause.code);
        pushValue(cause.name);
      }
    }

    return [...messages].some((value) => readonlyPattern.test(value));
  }

  private extractErrorReason(err: unknown): string {
    if (err instanceof Error && err.message.trim()) {
      return err.message;
    }
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message;
      }
      if (typeof record.code === "string" && record.code.trim()) {
        return record.code;
      }
    }
    return String(err);
  }

  private async runSyncWithReadonlyRecovery(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    try {
      await this.runSync(params);
      return;
    } catch (err) {
      if (!this.isReadonlyDbError(err) || this.closed) {
        throw err;
      }
      const reason = this.extractErrorReason(err);
      this.readonlyRecoveryAttempts += 1;
      this.readonlyRecoveryLastError = reason;
      log.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });
      try {
        this.db.close();
      } catch {}
      this.db = this.openDatabase();
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema();
      const meta = this.readMeta();
      this.vector.dims = meta?.vectorDims;
      try {
        await this.runSync(params);
        this.readonlyRecoverySuccesses += 1;
      } catch (retryErr) {
        this.readonlyRecoveryFailures += 1;
        throw retryErr;
      }
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    return await readMemoryFile({
      workspaceDir: this.workspaceDir,
      extraPaths: this.settings.extraPaths,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    });
  }

  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();
    const aggregateRows = this.db
      .prepare(
        `SELECT 'files' AS kind, source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source\n` +
          `UNION ALL\n` +
          `SELECT 'chunks' AS kind, source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
      )
      .all(...sourceFilter.params, ...sourceFilter.params) as Array<{
      kind: "files" | "chunks";
      source: MemorySource;
      c: number;
    }>;
    const aggregateState = (() => {
      const sources = Array.from(this.sources);
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      let files = 0;
      let chunks = 0;
      for (const row of aggregateRows) {
        const count = row.c ?? 0;
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        if (row.kind === "files") {
          entry.files = count;
          files += count;
        } else {
          entry.chunks = count;
          chunks += count;
        }
        bySource.set(row.source, entry);
      }
      return {
        files,
        chunks,
        sourceCounts: sources.map((source) => Object.assign({ source }, bySource.get(source)!)),
      };
    })();

    const searchMode = this.provider || !this.providerInitialized ? "hybrid" : "fts-only";
    const providerInfo = this.provider
      ? { provider: this.provider.id, model: this.provider.model }
      : this.providerInitialized
        ? { provider: "none", model: undefined }
        : { provider: this.requestedProvider, model: this.settings.model || undefined };

    return {
      backend: "builtin",
      files: aggregateState.files,
      chunks: aggregateState.chunks,
      dirty: this.dirty || this.sessionsDirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts: aggregateState.sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        limit: BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      },
      custom: {
        searchMode,
        providerUnavailableReason: this.providerUnavailableReason,
        readonlyRecovery: {
          attempts: this.readonlyRecoveryAttempts,
          successes: this.readonlyRecoverySuccesses,
          failures: this.readonlyRecoveryFailures,
          lastError: this.readonlyRecoveryLastError,
        },
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    await this.ensureProviderInitialized();
    // FTS-only mode: vector search not available
    if (!this.provider) {
      return false;
    }
    return this.ensureVectorReady();
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    await this.ensureProviderInitialized();
    // FTS-only mode: embeddings not available but search still works
    if (!this.provider) {
      return {
        ok: false,
        error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
      };
    }
    try {
      await this.embedBatchWithRetry(["ping"]);
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
    const pendingSync = this.syncing;
    const pendingProviderInit = this.providerInitPromise;
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
    if (pendingSync) {
      try {
        await pendingSync;
      } catch {}
    }
    if (pendingProviderInit) {
      try {
        await pendingProviderInit;
      } catch {}
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }
}

import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import chokidar, { FSWatcher } from "chokidar";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { type OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_GEMINI_EMBEDDING_MODEL } from "./embeddings-gemini.js";
import { DEFAULT_MISTRAL_EMBEDDING_MODEL } from "./embeddings-mistral.js";
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "./embeddings-ollama.js";
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from "./embeddings-openai.js";
import { DEFAULT_VOYAGE_EMBEDDING_MODEL } from "./embeddings-voyage.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { isFileMissingError } from "./fs-utils.js";
import {
  buildFileIdentityKey,
  buildFileEntry,
  ensureDir,
  hashText,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  runWithConcurrency,
} from "./internal.js";
import { type MemoryFileEntry } from "./internal.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  buildCaseInsensitiveExtensionGlob,
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
} from "./multimodal.js";
import type { SessionFileEntry } from "./session-files.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "./session-files.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import { requireNodeSqlite } from "./sqlite.js";
import type { MemorySource, MemorySyncProgressUpdate } from "./types.js";

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  sources?: MemorySource[];
  scopeHash?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

export class MemorySyncError extends Error {
  readonly kind: "provider" | "local";

  constructor(params: { kind: "provider" | "local"; message: string; cause?: unknown }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "MemorySyncError";
    this.kind = params.kind;
  }
}

type MemoryFileSyncResult = {
  syncedPaths: Set<string>;
  deletedPaths: Set<string>;
  retryableLocalFailures: Set<string>;
  localFailureError?: Error;
  fatalProviderError?: MemorySyncError;
  allowCommit: boolean;
};

type SessionFileSyncResult = {
  syncedFiles: Set<string>;
  failedFiles: Set<string>;
  localFailureError?: Error;
  fatalProviderError?: MemorySyncError;
  allowCommit: boolean;
};

type ReindexVerdict = {
  allowCommit: boolean;
  error?: Error;
};

type IndexedFileStateRow = {
  path: string;
  hash: string;
  identityKey: string | null;
};

type FailedRefreshCandidate = {
  replacementPath?: string;
};

type IndexedFileState = {
  rows: IndexedFileStateRow[];
  byPath: Map<string, IndexedFileStateRow>;
  byIdentityKey: Map<string, IndexedFileStateRow[]>;
};

const META_KEY = "memory_index_meta_v1";
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

const log = createSubsystemLogger("memory");

function shouldIgnoreMemoryWatchPath(watchPath: string): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized.split(path.sep).map((segment) => segment.trim().toLowerCase());
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

export function runDetachedMemorySync(sync: () => Promise<void>, reason: "interval" | "watch") {
  void sync().catch((err) => {
    log.warn(`memory sync failed (${reason}): ${String(err)}`);
  });
}

function isProviderSyncError(err: unknown): err is MemorySyncError {
  if (err instanceof MemorySyncError) {
    return err.kind === "provider";
  }
  return (
    err instanceof Error &&
    (err as { name?: unknown; kind?: unknown }).name === "MemorySyncError" &&
    (err as { kind?: unknown }).kind === "provider"
  );
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function collectErrorSignals(err: unknown): string[] {
  const values = new Set<string>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (trimmed) {
        values.add(trimmed);
      }
      continue;
    }
    if (current instanceof Error) {
      if (current.message.trim()) {
        values.add(current.message);
      }
      if (current.name.trim()) {
        values.add(current.name);
      }
      const withCode = current as Error & { code?: unknown; cause?: unknown };
      if (typeof withCode.code === "string" && withCode.code.trim()) {
        values.add(withCode.code);
      }
      if (withCode.cause) {
        queue.push(withCode.cause);
      }
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key of ["message", "code", "name"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) {
          values.add(value);
        }
      }
      if (record.cause) {
        queue.push(record.cause);
      }
    }
  }
  return [...values];
}

function shouldPropagateLocalSyncError(err: unknown): boolean {
  const signal = collectErrorSignals(err).join("\n");
  return /SQLITE_|readonly database|read-only|database is locked|database or disk is full|disk full|disk i\/o|ENOSPC/i.test(
    signal,
  );
}

function buildIndexedFileState(rows: IndexedFileStateRow[]): IndexedFileState {
  const byPath = new Map<string, IndexedFileStateRow>();
  const byIdentityKey = new Map<string, IndexedFileStateRow[]>();
  for (const row of rows) {
    byPath.set(row.path, row);
    if (!row.identityKey) {
      continue;
    }
    const matches = byIdentityKey.get(row.identityKey);
    if (matches) {
      matches.push(row);
    } else {
      byIdentityKey.set(row.identityKey, [row]);
    }
  }
  return { rows, byPath, byIdentityKey };
}

function resolveReplacementPath(params: {
  currentPath: string;
  currentIdentityKey: string | null | undefined;
  existingState?: IndexedFileState | null;
}): string | undefined {
  if (!params.currentIdentityKey || !params.existingState) {
    return undefined;
  }
  const matches = params.existingState.byIdentityKey.get(params.currentIdentityKey);
  if (!matches || matches.length !== 1) {
    return undefined;
  }
  const [match] = matches;
  if (!match || match.path === params.currentPath) {
    return undefined;
  }
  return match.path;
}

function selectProtectedStalePaths(failedRefreshes: FailedRefreshCandidate[]): Set<string> {
  const protectedPaths = new Set<string>();
  for (const failure of failedRefreshes) {
    if (failure.replacementPath) {
      protectedPaths.add(failure.replacementPath);
    }
  }
  return protectedPaths;
}

export abstract class MemoryManagerSyncOps {
  protected abstract readonly cfg: OpenClawConfig;
  protected abstract readonly agentId: string;
  protected abstract readonly workspaceDir: string;
  protected abstract readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null = null;
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  protected ollama?: OllamaEmbeddingClient;
  protected abstract batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected readonly sources: Set<MemorySource> = new Set();
  protected providerKey: string | null = null;
  protected abstract readonly vector: {
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
  } = { enabled: false, available: false };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected fallbackReason?: string;
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
  private indexWriteSavepointCounter = 0;
  private lastMetaSerialized: string | null = null;

  protected abstract readonly cache: { enabled: boolean; maxEntries?: number };
  protected abstract db: DatabaseSync;
  protected abstract computeProviderKey(): string;
  protected abstract sync(params?: {
    reason?: string;
    force?: boolean;
    forceSessions?: boolean;
    sessionFile?: string;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  protected abstract withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>;
  protected abstract getIndexConcurrency(): number;
  protected abstract pruneEmbeddingCacheIfNeeded(): void;
  protected abstract indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void>;

  protected withIndexWriteSavepoint<T>(action: () => T): T {
    const savepointName = `memory_index_write_${this.indexWriteSavepointCounter++}`;
    this.db.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = action();
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      } catch {}
      try {
        this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      } catch {}
      throw err;
    }
  }

  protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = (await this.vectorReady) || false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const resolvedPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath;
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
    if (this.vector.dims === dimensions) {
      return;
    }
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

  protected buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  protected openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path);
    return this.openDatabaseAtPath(dbPath);
  }

  private openDatabaseAtPath(dbPath: string): DatabaseSync {
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath, { allowExtension: this.settings.store.vector.enabled });
    // busy_timeout is per-connection and resets to 0 on restart.
    // Set it on every open so concurrent processes retry instead of
    // failing immediately with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }

  private seedEmbeddingCache(sourceDb: DatabaseSync): void {
    if (!this.cache.enabled) {
      return;
    }
    try {
      const rows = sourceDb
        .prepare(
          `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
        )
        .all() as Array<{
        provider: string;
        model: string;
        provider_key: string;
        hash: string;
        embedding: string;
        dims: number | null;
        updated_at: number;
      }>;
      if (!rows.length) {
        return;
      }
      const insert = this.db.prepare(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
           embedding=excluded.embedding,
           dims=excluded.dims,
           updated_at=excluded.updated_at`,
      );
      this.db.exec("BEGIN");
      for (const row of rows) {
        insert.run(
          row.provider,
          row.model,
          row.provider_key,
          row.hash,
          row.embedding,
          row.dims,
          row.updated_at,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  private async swapIndexFiles(targetPath: string, tempPath: string): Promise<void> {
    const backupPath = `${targetPath}.backup-${randomUUID()}`;
    await this.moveIndexFiles(targetPath, backupPath);
    try {
      await this.moveIndexFiles(tempPath, targetPath);
    } catch (err) {
      await this.moveIndexFiles(backupPath, targetPath);
      throw err;
    }
    await this.removeIndexFiles(backupPath);
  }

  private async moveIndexFiles(sourceBase: string, targetBase: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    for (const suffix of suffixes) {
      const source = `${sourceBase}${suffix}`;
      const target = `${targetBase}${suffix}`;
      try {
        await fs.rename(source, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  private async removeIndexFiles(basePath: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    await Promise.all(suffixes.map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
  }

  protected ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      cacheEnabled: this.cache.enabled,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      // Only warn when hybrid search is enabled; otherwise this is expected noise.
      if (this.fts.enabled) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    }
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) {
      return;
    }
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory", "**", "*.md"),
    ]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          watchPaths.add(path.join(entry, "**", "*.md"));
          if (this.settings.multimodal.enabled) {
            for (const modality of this.settings.multimodal.modalities) {
              for (const extension of getMemoryMultimodalExtensions(modality)) {
                watchPaths.add(
                  path.join(entry, "**", buildCaseInsensitiveExtensionGlob(extension)),
                );
              }
            }
          }
          continue;
        }
        if (
          stat.isFile() &&
          (entry.toLowerCase().endsWith(".md") ||
            classifyMemoryMultimodalPath(entry, this.settings.multimodal) !== null)
        ) {
          watchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      ignored: (watchPath) => shouldIgnoreMemoryWatchPath(String(watchPath)),
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

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) {
        return;
      }
      const sessionFile = update.sessionFile;
      if (!this.isSessionFileForAgent(sessionFile)) {
        return;
      }
      this.scheduleSessionDirty(sessionFile);
    });
  }

  private scheduleSessionDirty(sessionFile: string) {
    this.sessionPendingFiles.add(sessionFile);
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void this.processSessionDeltaBatch().catch((err) => {
        log.warn(`memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionDeltaBatch(): Promise<void> {
    if (this.sessionPendingFiles.size === 0) {
      return;
    }
    const pending = Array.from(this.sessionPendingFiles);
    this.sessionPendingFiles.clear();
    let shouldSync = false;
    for (const sessionFile of pending) {
      const delta = await this.updateSessionDelta(sessionFile);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.sessionsDirtyFiles.add(sessionFile);
      this.sessionsDirty = true;
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((err) => {
        log.warn(`memory sync failed (session-delta): ${String(err)}`);
      });
    }
  }

  private async updateSessionDelta(sessionFile: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) {
      return null;
    }
    let stat: { size: number };
    try {
      stat = await fs.stat(sessionFile);
    } catch {
      return null;
    }
    const size = stat.size;
    let state = this.sessionDeltas.get(sessionFile);
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionFile, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize);
    if (deltaBytes === 0 && size === state.lastSize) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    if (size < state.lastSize) {
      state.lastSize = size;
      state.pendingBytes += size;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
      }
    } else {
      state.pendingBytes += deltaBytes;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
      }
      state.lastSize = size;
    }
    this.sessionDeltas.set(sessionFile, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  private async countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) {
      return 0;
    }
    let handle;
    try {
      handle = await fs.open(absPath, "r");
    } catch (err) {
      if (isFileMissingError(err)) {
        return 0;
      }
      throw err;
    }
    try {
      let offset = start;
      let count = 0;
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) {
          break;
        }
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) {
            count += 1;
          }
        }
        offset += bytesRead;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  private resetSessionDelta(absPath: string, size: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) {
      return false;
    }
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
    const resolvedFile = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  private normalizeTargetSessionFiles(sessionFiles?: string[]): Set<string> | null {
    if (!sessionFiles || sessionFiles.length === 0) {
      return null;
    }
    const normalized = new Set<string>();
    for (const sessionFile of sessionFiles) {
      const trimmed = sessionFile.trim();
      if (!trimmed) {
        continue;
      }
      const resolved = path.resolve(trimmed);
      if (this.isSessionFileForAgent(resolved)) {
        normalized.add(resolved);
      }
    }
    return normalized.size > 0 ? normalized : null;
  }

  private clearSyncedSessionFiles(targetSessionFiles?: Iterable<string> | null) {
    if (!targetSessionFiles) {
      this.sessionsDirtyFiles.clear();
    } else {
      for (const targetSessionFile of targetSessionFiles) {
        this.sessionsDirtyFiles.delete(targetSessionFile);
      }
    }
    this.sessionsDirty = this.sessionsDirtyFiles.size > 0;
  }

  private markSessionFilesDirty(sessionFiles?: Iterable<string> | null) {
    if (!sessionFiles) {
      return;
    }
    for (const sessionFile of sessionFiles) {
      this.sessionsDirtyFiles.add(sessionFile);
    }
    this.sessionsDirty = this.sessionsDirtyFiles.size > 0;
  }

  private applySessionSyncResult(result: SessionFileSyncResult) {
    this.markSessionFilesDirty(result.failedFiles);
    this.clearSyncedSessionFiles(result.syncedFiles);
  }

  private createReindexVerdict(params: {
    memoryResult?: MemoryFileSyncResult;
    sessionResult?: SessionFileSyncResult;
  }): ReindexVerdict {
    if (params.memoryResult?.fatalProviderError) {
      return {
        allowCommit: false,
        error: params.memoryResult.fatalProviderError,
      };
    }
    if (params.sessionResult?.fatalProviderError) {
      return {
        allowCommit: false,
        error: params.sessionResult.fatalProviderError,
      };
    }
    if (params.memoryResult && !params.memoryResult.allowCommit) {
      return {
        allowCommit: false,
        error: params.memoryResult.localFailureError ?? new Error("memory reindex failed"),
      };
    }
    if (params.sessionResult && !params.sessionResult.allowCommit) {
      return {
        allowCommit: false,
        error: params.sessionResult.localFailureError ?? new Error("session reindex failed"),
      };
    }
    return { allowCommit: true };
  }

  private snapshotSyncState(): {
    dirty: boolean;
    sessionsDirty: boolean;
    sessionsDirtyFiles: Set<string>;
    sessionDeltas: Map<string, { lastSize: number; pendingBytes: number; pendingMessages: number }>;
    lastMetaSerialized: string | null;
    vectorDims: number | undefined;
  } {
    return {
      dirty: this.dirty,
      sessionsDirty: this.sessionsDirty,
      sessionsDirtyFiles: new Set(this.sessionsDirtyFiles),
      sessionDeltas: new Map(
        Array.from(this.sessionDeltas, ([sessionFile, state]) => [sessionFile, { ...state }]),
      ),
      lastMetaSerialized: this.lastMetaSerialized,
      vectorDims: this.vector.dims,
    };
  }

  private mergeSessionDeltas(
    snapshot: ReturnType<MemoryManagerSyncOps["snapshotSyncState"]>["sessionDeltas"],
    live: ReturnType<MemoryManagerSyncOps["snapshotSyncState"]>["sessionDeltas"],
  ) {
    const merged = new Map(
      Array.from(snapshot, ([sessionFile, state]) => [sessionFile, { ...state }]),
    );
    for (const [sessionFile, liveState] of live) {
      const snapshotState = merged.get(sessionFile);
      if (!snapshotState) {
        merged.set(sessionFile, { ...liveState });
        continue;
      }
      merged.set(sessionFile, {
        // Prefer the older baseline so a rolled-back reindex cannot discard bytes/messages
        // that arrived while the rebuild was running.
        lastSize: Math.min(snapshotState.lastSize, liveState.lastSize),
        pendingBytes: Math.max(snapshotState.pendingBytes, liveState.pendingBytes),
        pendingMessages: Math.max(snapshotState.pendingMessages, liveState.pendingMessages),
      });
    }
    return merged;
  }

  private restoreSyncState(
    snapshot: ReturnType<MemoryManagerSyncOps["snapshotSyncState"]>,
    liveState?: ReturnType<MemoryManagerSyncOps["snapshotSyncState"]>,
  ) {
    this.dirty = snapshot.dirty || liveState?.dirty === true;
    const mergedDirtyFiles = new Set(snapshot.sessionsDirtyFiles);
    for (const sessionFile of liveState?.sessionsDirtyFiles ?? []) {
      mergedDirtyFiles.add(sessionFile);
    }
    this.sessionsDirtyFiles = mergedDirtyFiles;
    this.sessionsDirty =
      snapshot.sessionsDirty || liveState?.sessionsDirty === true || mergedDirtyFiles.size > 0;
    this.sessionDeltas = liveState
      ? this.mergeSessionDeltas(snapshot.sessionDeltas, liveState.sessionDeltas)
      : new Map(
          Array.from(snapshot.sessionDeltas, ([sessionFile, state]) => [sessionFile, { ...state }]),
        );
    this.lastMetaSerialized = snapshot.lastMetaSerialized;
    this.vector.dims = snapshot.vectorDims;
  }

  private restoreRetryStateAfterReindexRollback(params: {
    memoryReindexStarted?: boolean;
    sessionReindexStarted?: boolean;
    sessionResult?: SessionFileSyncResult;
  }) {
    if (params.memoryReindexStarted) {
      this.dirty = true;
    }
    if (params.sessionReindexStarted) {
      this.sessionsDirty = true;
    }
    if (params.sessionResult) {
      this.markSessionFilesDirty(params.sessionResult.syncedFiles);
      this.markSessionFilesDirty(params.sessionResult.failedFiles);
    }
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      runDetachedMemorySync(() => this.sync({ reason: "interval" }), "interval");
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      runDetachedMemorySync(() => this.sync({ reason: "watch" }), "watch");
    }, this.settings.sync.watchDebounceMs);
  }

  private shouldSyncSessions(
    params?: { reason?: string; force?: boolean; sessionFiles?: string[] },
    needsFullReindex = false,
  ) {
    if (!this.sources.has("sessions")) {
      return false;
    }
    if (params?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
      return true;
    }
    if (params?.force) {
      return true;
    }
    const reason = params?.reason;
    if (reason === "session-start" || reason === "watch") {
      return false;
    }
    if (needsFullReindex) {
      return true;
    }
    return this.sessionsDirty;
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<MemoryFileSyncResult> {
    // FTS-only mode: skip embedding sync (no provider)
    if (!this.provider) {
      log.debug("Skipping memory file sync in FTS-only mode (no embedding provider)");
      return {
        syncedPaths: new Set<string>(),
        deletedPaths: new Set<string>(),
        retryableLocalFailures: new Set<string>(),
        allowCommit: true,
      };
    }
    const selectSourceFileState = this.db.prepare(
      `SELECT path, hash, identity_key FROM files WHERE source = ?`,
    );
    const deleteFileByPathAndSource = this.db.prepare(
      `DELETE FROM files WHERE path = ? AND source = ?`,
    );
    const updateFileIdentityByPathAndSource = this.db.prepare(
      `UPDATE files SET identity_key = ?, mtime = ?, size = ? WHERE path = ? AND source = ?`,
    );
    const deleteChunksByPathAndSource = this.db.prepare(
      `DELETE FROM chunks WHERE path = ? AND source = ?`,
    );
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
        : null;
    const deleteFtsRowsByPathSourceAndModel =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
        : null;

    const files = await listMemoryFiles(
      this.workspaceDir,
      this.settings.extraPaths,
      this.settings.multimodal,
    );
    const existingState = buildIndexedFileState(
      (
        selectSourceFileState.all("memory") as Array<{
          path: string;
          hash: string;
          identity_key: string | null;
        }>
      ).map((row) => ({
        path: row.path,
        hash: row.hash,
        identityKey: row.identity_key,
      })),
    );
    const existingRows = existingState.rows;
    const fileEntries: MemoryFileEntry[] = [];
    const activePaths = new Set<string>();
    const syncedPaths = new Set<string>();
    const deletedPaths = new Set<string>();
    const retryableLocalFailures = new Set<string>();
    const failedRefreshes: FailedRefreshCandidate[] = [];
    let localFailureError: Error | undefined;
    let fatalProviderError: MemorySyncError | undefined;
    let allowPrune = true;
    await runWithConcurrency(
      files.map((file) => async () => {
        try {
          const entry = await buildFileEntry(file, this.workspaceDir, this.settings.multimodal);
          if (!entry) {
            return;
          }
          activePaths.add(entry.path);
          fileEntries.push(entry);
        } catch (err) {
          const relPath = path.relative(this.workspaceDir, file).replace(/\\/g, "/");
          try {
            const stat = await fs.stat(file);
            activePaths.add(relPath);
            retryableLocalFailures.add(relPath);
            localFailureError ??= toError(err);
            const replacementPath = resolveReplacementPath({
              currentPath: relPath,
              currentIdentityKey: buildFileIdentityKey(stat),
              existingState,
            });
            failedRefreshes.push({
              replacementPath,
            });
            log.warn("memory sync: skipping memory file after read failure", {
              path: relPath,
              error: err instanceof Error ? err.message : String(err),
            });
          } catch (statErr) {
            if (!isFileMissingError(statErr)) {
              throw statErr;
            }
          }
        }
      }),
      this.getIndexConcurrency(),
    );
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
      });
    }

    const reportProgress = () => {
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    };
    const tasks = fileEntries.map((entry) => async () => {
      try {
        const existingRow = existingState.byPath.get(entry.path);
        if (!params.needsFullReindex && existingRow?.hash === entry.hash) {
          if (existingRow.identityKey !== entry.identityKey) {
            updateFileIdentityByPathAndSource.run(
              entry.identityKey,
              entry.mtimeMs,
              entry.size,
              entry.path,
              "memory",
            );
          }
          syncedPaths.add(entry.path);
          return;
        }
        try {
          await this.indexFile(entry, { source: "memory" });
          syncedPaths.add(entry.path);
        } catch (err) {
          if (isProviderSyncError(err)) {
            fatalProviderError ??= err;
            allowPrune = false;
            // Rethrow so runWithConcurrency stops scheduling more files.
            throw err;
          }
          if (shouldPropagateLocalSyncError(err)) {
            throw err;
          }
          const reason = err instanceof Error ? err.message : String(err);
          retryableLocalFailures.add(entry.path);
          localFailureError ??= toError(err);
          const replacementPath = resolveReplacementPath({
            currentPath: entry.path,
            currentIdentityKey: entry.identityKey,
            existingState,
          });
          failedRefreshes.push({
            replacementPath,
          });
          log.warn("memory sync: skipping memory file after index failure", {
            path: entry.path,
            error: reason,
          });
        }
      } finally {
        reportProgress();
      }
    });
    try {
      await runWithConcurrency(tasks, this.getIndexConcurrency());
    } catch (err) {
      if (!isProviderSyncError(err)) {
        throw err;
      }
      fatalProviderError ??= err;
      allowPrune = false;
    }

    if (allowPrune) {
      const staleRows = existingRows.filter((stale) => !activePaths.has(stale.path));
      const protectedStalePaths = selectProtectedStalePaths(failedRefreshes);
      for (const stale of staleRows) {
        if (protectedStalePaths.has(stale.path)) {
          continue;
        }
        deleteFileByPathAndSource.run(stale.path, "memory");
        if (deleteVectorRowsByPathAndSource) {
          try {
            deleteVectorRowsByPathAndSource.run(stale.path, "memory");
          } catch {}
        }
        deleteChunksByPathAndSource.run(stale.path, "memory");
        if (deleteFtsRowsByPathSourceAndModel) {
          try {
            deleteFtsRowsByPathSourceAndModel.run(stale.path, "memory", this.provider.model);
          } catch {}
        }
        deletedPaths.add(stale.path);
      }
    }

    return {
      syncedPaths,
      deletedPaths,
      retryableLocalFailures,
      localFailureError,
      fatalProviderError,
      allowCommit: !fatalProviderError && retryableLocalFailures.size === 0,
    };
  }

  private async syncSessionFiles(params: {
    needsFullReindex: boolean;
    targetSessionFiles?: string[];
    progress?: MemorySyncProgressState;
  }): Promise<SessionFileSyncResult> {
    const syncedFiles = new Set<string>();
    const failedFiles = new Set<string>();
    const failedRefreshes: FailedRefreshCandidate[] = [];
    let localFailureError: Error | undefined;
    let fatalProviderError: MemorySyncError | undefined;
    let allowPrune = true;
    // FTS-only mode: skip embedding sync (no provider)
    if (!this.provider) {
      log.debug("Skipping session file sync in FTS-only mode (no embedding provider)");
      return { syncedFiles, failedFiles, allowCommit: true };
    }
    const providerModel = this.provider.model;
    const selectFileHash = this.db.prepare(
      `SELECT hash, identity_key FROM files WHERE path = ? AND source = ?`,
    );
    const selectSourceFileState = this.db.prepare(
      `SELECT path, hash, identity_key FROM files WHERE source = ?`,
    );
    const deleteFileByPathAndSource = this.db.prepare(
      `DELETE FROM files WHERE path = ? AND source = ?`,
    );
    const updateFileIdentityByPathAndSource = this.db.prepare(
      `UPDATE files SET identity_key = ?, mtime = ?, size = ? WHERE path = ? AND source = ?`,
    );
    const deleteChunksByPathAndSource = this.db.prepare(
      `DELETE FROM chunks WHERE path = ? AND source = ?`,
    );
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
        : null;
    const deleteFtsRowsByPathSourceAndModel =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
        : null;

    const targetSessionFiles = params.needsFullReindex
      ? null
      : this.normalizeTargetSessionFiles(params.targetSessionFiles);
    const files = targetSessionFiles
      ? Array.from(targetSessionFiles)
      : await listSessionFilesForAgent(this.agentId);
    const activePaths = targetSessionFiles
      ? null
      : new Set(files.map((file) => sessionPathForFile(file)));
    const existingState =
      activePaths === null
        ? null
        : buildIndexedFileState(
            (
              selectSourceFileState.all("sessions") as Array<{
                path: string;
                hash: string;
                identity_key: string | null;
              }>
            ).map((row) => ({
              path: row.path,
              hash: row.hash,
              identityKey: row.identity_key,
            })),
          );
    const existingRows = existingState?.rows ?? null;
    const indexAll =
      params.needsFullReindex || Boolean(targetSessionFiles) || this.sessionsDirtyFiles.size === 0;
    log.debug("memory sync: indexing session files", {
      files: files.length,
      indexAll,
      dirtyFiles: this.sessionsDirtyFiles.size,
      targetedFiles: targetSessionFiles?.size ?? 0,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing session files (batch)..." : "Indexing session files…",
      });
    }

    const reportProgress = () => {
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    };
    const tasks = files.map((absPath) => async () => {
      try {
        if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
          return;
        }
        const entry = await buildSessionEntry(absPath);
        if (!entry) {
          try {
            const stat = await fs.stat(absPath);
            failedFiles.add(absPath);
            localFailureError ??= new Error(`Failed reading session file ${absPath}`);
            const sessionPath = sessionPathForFile(absPath);
            const replacementPath = resolveReplacementPath({
              currentPath: sessionPath,
              currentIdentityKey: buildFileIdentityKey(stat),
              existingState,
            });
            failedRefreshes.push({
              replacementPath,
            });
          } catch (err) {
            if (!isFileMissingError(err)) {
              throw err;
            }
            const sessionPath = sessionPathForFile(absPath);
            deleteFileByPathAndSource.run(sessionPath, "sessions");
            if (deleteVectorRowsByPathAndSource) {
              try {
                deleteVectorRowsByPathAndSource.run(sessionPath, "sessions");
              } catch {}
            }
            deleteChunksByPathAndSource.run(sessionPath, "sessions");
            if (deleteFtsRowsByPathSourceAndModel) {
              try {
                deleteFtsRowsByPathSourceAndModel.run(sessionPath, "sessions", providerModel);
              } catch {}
            }
            this.sessionDeltas.delete(absPath);
            syncedFiles.add(absPath);
          }
          return;
        }
        const existingRow =
          existingState?.byPath.get(entry.path) ??
          (() => {
            const row = selectFileHash.get(entry.path, "sessions") as
              | {
                  hash: string;
                  identity_key: string | null;
                }
              | undefined;
            if (!row) {
              return undefined;
            }
            return {
              path: entry.path,
              hash: row.hash,
              identityKey: row.identity_key,
            };
          })();
        if (!params.needsFullReindex && existingRow?.hash === entry.hash) {
          if (!existingState || existingRow.identityKey !== entry.identityKey) {
            updateFileIdentityByPathAndSource.run(
              entry.identityKey,
              entry.mtimeMs,
              entry.size,
              entry.path,
              "sessions",
            );
          }
          this.resetSessionDelta(absPath, entry.size);
          syncedFiles.add(absPath);
          return;
        }
        try {
          await this.indexFile(entry, { source: "sessions", content: entry.content });
          this.resetSessionDelta(absPath, entry.size);
          syncedFiles.add(absPath);
        } catch (err) {
          if (isProviderSyncError(err)) {
            fatalProviderError ??= err;
            allowPrune = false;
            // Rethrow so runWithConcurrency stops scheduling more files.
            throw err;
          }
          if (shouldPropagateLocalSyncError(err)) {
            throw err;
          }
          const reason = err instanceof Error ? err.message : String(err);
          failedFiles.add(absPath);
          localFailureError ??= toError(err);
          const replacementPath = resolveReplacementPath({
            currentPath: entry.path,
            currentIdentityKey: entry.identityKey,
            existingState,
          });
          failedRefreshes.push({
            replacementPath,
          });
          log.warn("memory sync: skipping session file after index failure", {
            path: entry.path,
            error: reason,
          });
        }
      } finally {
        reportProgress();
      }
    });
    try {
      await runWithConcurrency(tasks, this.getIndexConcurrency());
    } catch (err) {
      if (!isProviderSyncError(err)) {
        throw err;
      }
      fatalProviderError ??= err;
      allowPrune = false;
    }

    if (activePaths === null) {
      // Targeted syncs only refresh the requested transcripts and should not
      // prune unrelated session rows without a full directory enumeration.
      return {
        syncedFiles,
        failedFiles,
        localFailureError,
        fatalProviderError,
        allowCommit: !fatalProviderError && failedFiles.size === 0,
      };
    }

    if (allowPrune) {
      const staleRows = (existingRows ?? []).filter((stale) => !activePaths.has(stale.path));
      const protectedStalePaths = selectProtectedStalePaths(failedRefreshes);
      for (const stale of staleRows) {
        if (protectedStalePaths.has(stale.path)) {
          continue;
        }
        const staleAbsPath = path.join(
          resolveSessionTranscriptsDirForAgent(this.agentId),
          path.basename(stale.path),
        );
        deleteFileByPathAndSource.run(stale.path, "sessions");
        if (deleteVectorRowsByPathAndSource) {
          try {
            deleteVectorRowsByPathAndSource.run(stale.path, "sessions");
          } catch {}
        }
        deleteChunksByPathAndSource.run(stale.path, "sessions");
        if (deleteFtsRowsByPathSourceAndModel) {
          try {
            deleteFtsRowsByPathSourceAndModel.run(stale.path, "sessions", providerModel);
          } catch {}
        }
        this.sessionDeltas.delete(staleAbsPath);
        syncedFiles.add(staleAbsPath);
      }
    }

    return {
      syncedFiles,
      failedFiles,
      localFailureError,
      fatalProviderError,
      allowCommit: !fatalProviderError && failedFiles.size === 0,
    };
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  protected async runSync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Loading vector extension…",
      });
    }
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const configuredSources = this.resolveConfiguredSourcesForMeta();
    const configuredScopeHash = this.resolveConfiguredScopeHash();
    const targetSessionFiles = this.normalizeTargetSessionFiles(params?.sessionFiles);
    const hasTargetSessionFiles = targetSessionFiles !== null;
    if (hasTargetSessionFiles && targetSessionFiles && this.sources.has("sessions")) {
      // Post-compaction refreshes should only update the explicit transcript files and
      // leave broader reindex/dirty-work decisions to the regular sync path.
      try {
        const result = await this.syncSessionFiles({
          needsFullReindex: false,
          targetSessionFiles: Array.from(targetSessionFiles),
          progress: progress ?? undefined,
        });
        if (result.fatalProviderError) {
          throw result.fatalProviderError;
        }
        this.applySessionSyncResult(result);
        if (result.failedFiles.size > 0) {
          throw new MemorySyncError({
            kind: "local",
            message: "session refresh failed",
          });
        }
      } catch (err) {
        const activated =
          isProviderSyncError(err) && (await this.activateFallbackProvider(err.message));
        if (activated) {
          if (
            process.env.OPENCLAW_TEST_FAST === "1" &&
            process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1"
          ) {
            await this.runUnsafeReindex({
              reason: params?.reason,
              force: true,
              progress: progress ?? undefined,
            });
          } else {
            await this.runSafeReindex({
              reason: params?.reason,
              force: true,
              progress: progress ?? undefined,
            });
          }
          return;
        }
        throw err;
      }
      return;
    }
    const needsFullReindex =
      (params?.force && !hasTargetSessionFiles) ||
      !meta ||
      (this.provider && meta.model !== this.provider.model) ||
      (this.provider && meta.provider !== this.provider.id) ||
      meta.providerKey !== this.providerKey ||
      this.metaSourcesDiffer(meta, configuredSources) ||
      meta.scopeHash !== configuredScopeHash ||
      meta.chunkTokens !== this.settings.chunking.tokens ||
      meta.chunkOverlap !== this.settings.chunking.overlap ||
      (vectorReady && !meta?.vectorDims);
    try {
      if (needsFullReindex) {
        if (
          process.env.OPENCLAW_TEST_FAST === "1" &&
          process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1"
        ) {
          await this.runUnsafeReindex({
            reason: params?.reason,
            force: params?.force,
            progress: progress ?? undefined,
          });
        } else {
          await this.runSafeReindex({
            reason: params?.reason,
            force: params?.force,
            progress: progress ?? undefined,
          });
        }
        return;
      }

      const shouldSyncMemory =
        this.sources.has("memory") &&
        ((!hasTargetSessionFiles && params?.force) || needsFullReindex || this.dirty);
      const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

      if (shouldSyncMemory) {
        const result = await this.syncMemoryFiles({
          needsFullReindex,
          progress: progress ?? undefined,
        });
        if (result.fatalProviderError) {
          throw result.fatalProviderError;
        }
        this.dirty = result.retryableLocalFailures.size > 0;
      }

      if (shouldSyncSessions) {
        const result = await this.syncSessionFiles({
          needsFullReindex,
          targetSessionFiles: targetSessionFiles ? Array.from(targetSessionFiles) : undefined,
          progress: progress ?? undefined,
        });
        if (result.fatalProviderError) {
          throw result.fatalProviderError;
        }
        this.applySessionSyncResult(result);
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }
    } catch (err) {
      const activated =
        isProviderSyncError(err) && (await this.activateFallbackProvider(err.message));
      if (activated) {
        await this.runSafeReindex({
          reason: params?.reason ?? "fallback",
          force: true,
          progress: progress ?? undefined,
        });
        return;
      }
      throw err;
    }
  }

  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.settings.remote?.batch;
    const enabled = Boolean(
      batch?.enabled &&
      this.provider &&
      ((this.openAi && this.provider.id === "openai") ||
        (this.gemini && this.provider.id === "gemini") ||
        (this.voyage && this.provider.id === "voyage")),
    );
    return {
      enabled,
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
    };
  }

  private async activateFallbackProvider(reason: string): Promise<boolean> {
    const fallback = this.settings.fallback;
    if (!fallback || fallback === "none" || !this.provider || fallback === this.provider.id) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }
    const fallbackFrom = this.provider.id as
      | "openai"
      | "gemini"
      | "local"
      | "voyage"
      | "mistral"
      | "ollama";

    const fallbackModel =
      fallback === "gemini"
        ? DEFAULT_GEMINI_EMBEDDING_MODEL
        : fallback === "openai"
          ? DEFAULT_OPENAI_EMBEDDING_MODEL
          : fallback === "voyage"
            ? DEFAULT_VOYAGE_EMBEDDING_MODEL
            : fallback === "mistral"
              ? DEFAULT_MISTRAL_EMBEDDING_MODEL
              : fallback === "ollama"
                ? DEFAULT_OLLAMA_EMBEDDING_MODEL
                : this.settings.model;

    const fallbackResult = await createEmbeddingProvider({
      config: this.cfg,
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      provider: fallback,
      remote: this.settings.remote,
      model: fallbackModel,
      outputDimensionality: this.settings.outputDimensionality,
      fallback: "none",
      local: this.settings.local,
    });

    this.fallbackFrom = fallbackFrom;
    this.fallbackReason = reason;
    this.provider = fallbackResult.provider;
    this.openAi = fallbackResult.openAi;
    this.gemini = fallbackResult.gemini;
    this.voyage = fallbackResult.voyage;
    this.mistral = fallbackResult.mistral;
    this.ollama = fallbackResult.ollama;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    log.warn(`memory embeddings: switched to fallback provider (${fallback})`, { reason });
    return true;
  }

  private async runSafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    const dbPath = resolveUserPath(this.settings.store.path);
    const tempDbPath = `${dbPath}.tmp-${randomUUID()}`;
    const tempDb = this.openDatabaseAtPath(tempDbPath);

    const originalDb = this.db;
    let originalDbClosed = false;
    const originalState = {
      ftsAvailable: this.fts.available,
      ftsError: this.fts.loadError,
      vectorAvailable: this.vector.available,
      vectorLoadError: this.vector.loadError,
      vectorDims: this.vector.dims,
      vectorReady: this.vectorReady,
    };
    const originalSyncState = this.snapshotSyncState();

    const restoreOriginalState = () => {
      if (originalDbClosed) {
        this.db = this.openDatabaseAtPath(dbPath);
      } else {
        this.db = originalDb;
      }
      this.fts.available = originalState.ftsAvailable;
      this.fts.loadError = originalState.ftsError;
      this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
      this.vector.loadError = originalState.vectorLoadError;
      this.vector.dims = originalState.vectorDims;
      this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
    };

    this.db = tempDb;
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.fts.available = false;
    this.fts.loadError = undefined;
    this.ensureSchema();

    let nextMeta: MemoryIndexMeta | null = null;
    let memoryResult: MemoryFileSyncResult | undefined;
    let sessionResult: SessionFileSyncResult | undefined;
    let memoryReindexStarted = false;
    let sessionReindexStarted = false;

    try {
      this.seedEmbeddingCache(originalDb);
      const shouldSyncMemory = this.sources.has("memory");
      const shouldSyncSessions = this.shouldSyncSessions(
        { reason: params.reason, force: params.force },
        true,
      );

      if (shouldSyncMemory) {
        memoryReindexStarted = true;
        memoryResult = await this.syncMemoryFiles({
          needsFullReindex: true,
          progress: params.progress,
        });
      }

      if (shouldSyncSessions) {
        sessionReindexStarted = true;
        sessionResult = await this.syncSessionFiles({
          needsFullReindex: true,
          progress: params.progress,
        });
      }

      const verdict = this.createReindexVerdict({
        memoryResult,
        sessionResult,
      });
      if (!verdict.allowCommit) {
        throw verdict.error;
      }

      if (memoryResult) {
        this.dirty = memoryResult.retryableLocalFailures.size > 0;
      }

      if (sessionResult) {
        this.applySessionSyncResult(sessionResult);
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }

      nextMeta = {
        model: this.provider?.model ?? "fts-only",
        provider: this.provider?.id ?? "none",
        providerKey: this.providerKey!,
        sources: this.resolveConfiguredSourcesForMeta(),
        scopeHash: this.resolveConfiguredScopeHash(),
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
      };
      if (!nextMeta) {
        throw new Error("Failed to compute memory index metadata for reindexing.");
      }

      if (this.vector.available && this.vector.dims) {
        nextMeta.vectorDims = this.vector.dims;
      }

      this.writeMeta(nextMeta);
      this.pruneEmbeddingCacheIfNeeded?.();

      this.db.close();
      originalDb.close();
      originalDbClosed = true;

      await this.swapIndexFiles(dbPath, tempDbPath);

      this.db = this.openDatabaseAtPath(dbPath);
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema();
      this.vector.dims = nextMeta?.vectorDims;
    } catch (err) {
      const liveSyncState = this.snapshotSyncState();
      try {
        this.db.close();
      } catch {}
      await this.removeIndexFiles(tempDbPath);
      restoreOriginalState();
      this.restoreSyncState(originalSyncState, liveSyncState);
      this.restoreRetryStateAfterReindexRollback({
        memoryReindexStarted,
        sessionReindexStarted,
        sessionResult,
      });
      throw err;
    }
  }

  private async runUnsafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    // Perf: for test runs, skip atomic temp-db swapping. The index is isolated
    // under the per-test HOME anyway, and this cuts substantial fs+sqlite churn.
    const originalSyncState = this.snapshotSyncState();
    let memoryResult: MemoryFileSyncResult | undefined;
    let sessionResult: SessionFileSyncResult | undefined;
    let memoryReindexStarted = false;
    let sessionReindexStarted = false;

    this.db.exec("BEGIN");
    try {
      this.resetIndex();

      const shouldSyncMemory = this.sources.has("memory");
      const shouldSyncSessions = this.shouldSyncSessions(
        { reason: params.reason, force: params.force },
        true,
      );

      if (shouldSyncMemory) {
        memoryReindexStarted = true;
        memoryResult = await this.syncMemoryFiles({
          needsFullReindex: true,
          progress: params.progress,
        });
      }

      if (shouldSyncSessions) {
        sessionReindexStarted = true;
        sessionResult = await this.syncSessionFiles({
          needsFullReindex: true,
          progress: params.progress,
        });
      }

      const verdict = this.createReindexVerdict({
        memoryResult,
        sessionResult,
      });
      if (!verdict.allowCommit) {
        throw verdict.error;
      }

      if (memoryResult) {
        this.dirty = memoryResult.retryableLocalFailures.size > 0;
      }

      if (sessionResult) {
        this.applySessionSyncResult(sessionResult);
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }

      const nextMeta: MemoryIndexMeta = {
        model: this.provider?.model ?? "fts-only",
        provider: this.provider?.id ?? "none",
        providerKey: this.providerKey!,
        sources: this.resolveConfiguredSourcesForMeta(),
        scopeHash: this.resolveConfiguredScopeHash(),
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
      };
      if (this.vector.available && this.vector.dims) {
        nextMeta.vectorDims = this.vector.dims;
      }

      this.writeMeta(nextMeta);
      this.pruneEmbeddingCacheIfNeeded?.();
      this.db.exec("COMMIT");
    } catch (err) {
      const liveSyncState = this.snapshotSyncState();
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.restoreSyncState(originalSyncState, liveSyncState);
      this.restoreRetryStateAfterReindexRollback({
        memoryReindexStarted,
        sessionReindexStarted,
        sessionResult,
      });
      throw err;
    }
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DELETE FROM ${FTS_TABLE}`);
      } catch {}
    }
    this.dropVectorTable();
    this.vector.dims = undefined;
    this.sessionsDirtyFiles.clear();
  }

  protected readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) {
      this.lastMetaSerialized = null;
      return null;
    }
    try {
      const parsed = JSON.parse(row.value) as MemoryIndexMeta;
      this.lastMetaSerialized = row.value;
      return parsed;
    } catch {
      this.lastMetaSerialized = null;
      return null;
    }
  }

  protected writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    if (this.lastMetaSerialized === value) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
    this.lastMetaSerialized = value;
  }

  private resolveConfiguredSourcesForMeta(): MemorySource[] {
    const normalized = Array.from(this.sources)
      .filter((source): source is MemorySource => source === "memory" || source === "sessions")
      .toSorted();
    return normalized.length > 0 ? normalized : ["memory"];
  }

  private normalizeMetaSources(meta: MemoryIndexMeta): MemorySource[] {
    if (!Array.isArray(meta.sources)) {
      // Backward compatibility for older indexes that did not persist sources.
      return ["memory"];
    }
    const normalized = Array.from(
      new Set(
        meta.sources.filter(
          (source): source is MemorySource => source === "memory" || source === "sessions",
        ),
      ),
    ).toSorted();
    return normalized.length > 0 ? normalized : ["memory"];
  }

  private resolveConfiguredScopeHash(): string {
    const extraPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths)
      .map((value) => value.replace(/\\/g, "/"))
      .toSorted();
    return hashText(
      JSON.stringify({
        extraPaths,
        multimodal: {
          enabled: this.settings.multimodal.enabled,
          modalities: [...this.settings.multimodal.modalities].toSorted(),
          maxFileBytes: this.settings.multimodal.maxFileBytes,
        },
      }),
    );
  }

  private metaSourcesDiffer(meta: MemoryIndexMeta, configuredSources: MemorySource[]): boolean {
    const metaSources = this.normalizeMetaSources(meta);
    if (metaSources.length !== configuredSources.length) {
      return true;
    }
    return metaSources.some((source, index) => source !== configuredSources[index]);
  }
}

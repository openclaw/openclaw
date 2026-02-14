import chokidar, { type FSWatcher } from "chokidar";
import { MongoClient, type Db } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedMemoryBackendConfig } from "./backend-config.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";
import {
  chunksCollection,
  detectCapabilities,
  ensureCollections,
  ensureSearchIndexes,
  ensureStandardIndexes,
  filesCollection,
} from "./mongodb-schema.js";
import { mongoSearch } from "./mongodb-search.js";
import { syncToMongoDB } from "./mongodb-sync.js";

const log = createSubsystemLogger("memory:mongodb");

/** Redact credentials from a MongoDB connection string for safe logging. */
function redactMongoURI(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.password) {
      parsed.password = "***";
    }
    if (parsed.username) {
      parsed.username = parsed.username.slice(0, 2) + "***";
    }
    return parsed.toString();
  } catch {
    // If URL parsing fails, do a simple regex-based redaction
    return uri.replace(/\/\/([^:]+):([^@]+)@/, "//***:***@");
  }
}

// ---------------------------------------------------------------------------
// MongoDBMemoryManager — implements MemorySearchManager for MongoDB backend
// ---------------------------------------------------------------------------

export class MongoDBMemoryManager implements MemorySearchManager {
  private readonly client: MongoClient;
  private readonly db: Db;
  private readonly prefix: string;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly extraPaths: string[];
  private readonly capabilities: DetectedCapabilities;
  private readonly config: ResolvedMemoryBackendConfig;
  private embeddingProvider: EmbeddingProvider | null = null;
  private syncing: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private dirty = true;
  private fileCount = 0;
  private chunkCount = 0;

  private constructor(params: {
    client: MongoClient;
    db: Db;
    prefix: string;
    agentId: string;
    workspaceDir: string;
    extraPaths: string[];
    capabilities: DetectedCapabilities;
    config: ResolvedMemoryBackendConfig;
    embeddingProvider: EmbeddingProvider | null;
  }) {
    this.client = params.client;
    this.db = params.db;
    this.prefix = params.prefix;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.extraPaths = params.extraPaths;
    this.capabilities = params.capabilities;
    this.config = params.config;
    this.embeddingProvider = params.embeddingProvider;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
  }): Promise<MongoDBMemoryManager | null> {
    const mongoCfg = params.resolved.mongodb;
    if (!mongoCfg) {
      return null;
    }

    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const extraPaths = normalizeExtraMemoryPaths(
      workspaceDir,
      params.cfg.agents?.defaults?.memorySearch?.extraPaths,
    );

    // Connect to MongoDB with a timeout to avoid hanging
    const safeUri = redactMongoURI(mongoCfg.uri);
    log.info(`connecting to MongoDB: ${safeUri} (db=${mongoCfg.database})`);
    const client = new MongoClient(mongoCfg.uri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    });
    try {
      await client.connect();
      // Verify the connection actually works with a ping
      await client.db("admin").command({ ping: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`failed to connect to MongoDB (${safeUri}): ${msg}`);
      try {
        await client.close();
      } catch {
        // Ignore close errors during failed connect
      }
      return null;
    }

    const db = client.db(mongoCfg.database);
    const prefix = mongoCfg.collectionPrefix;

    // Ensure collections + standard indexes
    await ensureCollections(db, prefix);
    await ensureStandardIndexes(db, prefix);

    // Detect what the connected MongoDB supports
    const capabilities = await detectCapabilities(db);
    log.info(`capabilities: ${JSON.stringify(capabilities)}`);

    // Create search indexes (text + vector) if applicable
    await ensureSearchIndexes(
      db,
      prefix,
      mongoCfg.deploymentProfile,
      mongoCfg.embeddingMode,
      mongoCfg.quantization,
    );

    // If in managed embedding mode, set up an embedding provider
    let embeddingProvider: EmbeddingProvider | null = null;
    if (mongoCfg.embeddingMode === "managed") {
      try {
        const { createEmbeddingProvider } = await import("./embeddings.js");
        const { resolveMemorySearchConfig } = await import("../agents/memory-search.js");
        const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
        if (settings) {
          const { resolveAgentDir } = await import("../agents/agent-scope.js");
          const result = await createEmbeddingProvider({
            config: params.cfg,
            agentDir: resolveAgentDir(params.cfg, params.agentId),
            provider: settings.provider,
            remote: settings.remote,
            model: settings.model,
            fallback: settings.fallback,
            local: settings.local,
          });
          embeddingProvider = result.provider;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`managed embedding provider unavailable: ${msg}`);
      }
    }

    const manager = new MongoDBMemoryManager({
      client,
      db,
      prefix,
      agentId: params.agentId,
      workspaceDir,
      extraPaths,
      capabilities,
      config: params.resolved,
      embeddingProvider,
    });

    // Start watching memory files for changes
    manager.ensureWatcher();

    log.info(
      `ready: profile=${mongoCfg.deploymentProfile} embedding=${mongoCfg.embeddingMode} ` +
        `fusion=${mongoCfg.fusionMethod} caps=${JSON.stringify(capabilities)}`,
    );

    return manager;
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.search
  // ---------------------------------------------------------------------------

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    // Trigger sync if dirty
    if (this.dirty) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`sync on search failed: ${String(err)}`);
      });
    }

    const mongoCfg = this.config.mongodb!;
    const maxResults = opts?.maxResults ?? 10;
    const minScore = opts?.minScore ?? 0.1;

    // In managed mode, generate query embedding using the application's provider.
    // In automated mode, MongoDB generates the query embedding via Voyage AI at
    // query-time using `query: { text }` — no queryVector needed.
    let queryVector: number[] | null = null;
    if (mongoCfg.embeddingMode === "managed" && this.embeddingProvider) {
      try {
        queryVector = await this.embeddingProvider.embedQuery(cleaned);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`query embedding failed: ${msg}`);
      }
    }

    return mongoSearch(chunksCollection(this.db, this.prefix), cleaned, queryVector, {
      maxResults,
      minScore,
      sessionKey: opts?.sessionKey,
      fusionMethod: mongoCfg.fusionMethod,
      capabilities: this.capabilities,
      vectorIndexName: `${this.prefix}chunks_vector`,
      textIndexName: `${this.prefix}chunks_text`,
      vectorWeight: 0.7,
      textWeight: 0.3,
      embeddingMode: mongoCfg.embeddingMode,
    });
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.readFile
  // ---------------------------------------------------------------------------

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
    if (!allowedWorkspace && this.extraPaths.length > 0) {
      for (const additionalPath of this.extraPaths) {
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
          if (stat.isFile() && absPath === additionalPath && absPath.endsWith(".md")) {
            allowedAdditional = true;
            break;
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

  // ---------------------------------------------------------------------------
  // MemorySearchManager.status
  // ---------------------------------------------------------------------------

  status(): MemoryProviderStatus {
    const mongoCfg = this.config.mongodb!;
    return {
      backend: "mongodb",
      provider:
        mongoCfg.embeddingMode === "automated"
          ? "mongodb-automated"
          : (this.embeddingProvider?.id ?? "none"),
      model:
        mongoCfg.embeddingMode === "automated"
          ? "voyage-4-large (automated)"
          : this.embeddingProvider?.model,
      files: this.fileCount,
      chunks: this.chunkCount,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      sources: ["memory", "sessions"],
      custom: {
        deploymentProfile: mongoCfg.deploymentProfile,
        embeddingMode: mongoCfg.embeddingMode,
        fusionMethod: mongoCfg.fusionMethod,
        capabilities: this.capabilities,
        database: mongoCfg.database,
        collectionPrefix: mongoCfg.collectionPrefix,
        quantization: mongoCfg.quantization,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.sync
  // ---------------------------------------------------------------------------

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const mongoCfg = this.config.mongodb!;
    try {
      const result = await syncToMongoDB({
        db: this.db,
        prefix: this.prefix,
        agentId: this.agentId,
        workspaceDir: this.workspaceDir,
        extraPaths: this.extraPaths,
        embeddingMode: mongoCfg.embeddingMode,
        embeddingProvider: this.embeddingProvider ?? undefined,
        model: this.embeddingProvider?.model,
        reason: params?.reason,
        force: params?.force,
        progress: params?.progress,
      });

      // Query actual totals from MongoDB (not just the delta from this sync)
      try {
        this.fileCount = await filesCollection(this.db, this.prefix).countDocuments();
        this.chunkCount = await chunksCollection(this.db, this.prefix).countDocuments();
      } catch {
        // Fallback to delta counts if count query fails
        this.fileCount = result.filesProcessed + result.sessionFilesProcessed;
        this.chunkCount = result.chunksUpserted + result.sessionChunksUpserted;
      }

      this.dirty = false;
      log.info(
        `sync complete: processed=${result.filesProcessed}+${result.sessionFilesProcessed} ` +
          `chunks=${result.chunksUpserted}+${result.sessionChunksUpserted} ` +
          `totals=${this.fileCount} files, ${this.chunkCount} chunks`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`sync failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // File watcher (chokidar)
  // ---------------------------------------------------------------------------

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    const mongoCfg = this.config.mongodb!;
    const debounceMs = mongoCfg.watchDebounceMs;
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory"),
      ...this.extraPaths,
    ]);
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: debounceMs,
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
    this.watcher.on("error", (err) => {
      log.warn(`file watcher error: ${String(err)}`);
    });
  }

  private scheduleWatchSync(): void {
    const mongoCfg = this.config.mongodb!;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`memory sync failed (watch): ${String(err)}`);
      });
    }, mongoCfg.watchDebounceMs);
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.probeEmbeddingAvailability
  // ---------------------------------------------------------------------------

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const mongoCfg = this.config.mongodb!;

    // In automated mode, MongoDB handles embeddings — always available if vector search works
    if (mongoCfg.embeddingMode === "automated") {
      return this.capabilities.vectorSearch
        ? { ok: true }
        : { ok: false, error: "vector search not available on this MongoDB deployment" };
    }

    // In managed mode, test the embedding provider
    if (!this.embeddingProvider) {
      return { ok: false, error: "no embedding provider configured" };
    }
    try {
      await this.embeddingProvider.embedBatch(["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.probeVectorAvailability
  // ---------------------------------------------------------------------------

  async probeVectorAvailability(): Promise<boolean> {
    return this.capabilities.vectorSearch;
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.close
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    // Clear the debounced sync timer
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }

    // Close the file watcher
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch {
        // Ignore watcher close errors
      }
      this.watcher = null;
    }

    // Wait for any in-flight sync to complete before closing the connection
    if (this.syncing) {
      try {
        await this.syncing;
      } catch {
        // Ignore sync errors during close — already logged in runSync
      }
    }

    // Close the MongoDB connection
    try {
      await this.client.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`error closing MongoDB connection: ${msg}`);
    }
  }
}

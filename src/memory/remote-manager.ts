import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedMemoryBackendConfig, ResolvedRemoteConfig } from "./backend-config.js";
import { buildFileEntry, listMemoryFiles } from "./internal.js";
import { RemoteVectorStoreClient, extractSearchResultText } from "./remote-client.js";
import { RemoteManifest } from "./remote-manifest.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
} from "./types.js";

const log = createSubsystemLogger("memory:remote");

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".html", ".htm"]);

type RemoteManagerMode = "full" | "status";

export class RemoteVectorStoreManager implements MemorySearchManager {
  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
    mode?: RemoteManagerMode;
  }): Promise<RemoteVectorStoreManager | null> {
    const remote = params.resolved.remote;
    if (!remote) {
      return null;
    }
    const manager = new RemoteVectorStoreManager({
      cfg: params.cfg,
      agentId: params.agentId,
      remote,
    });
    await manager.initialize(params.mode ?? "full");
    return manager;
  }

  private readonly cfg: OpenClawConfig;
  private readonly agentId: string;
  private readonly remote: ResolvedRemoteConfig;
  private readonly workspaceDir: string;
  private readonly manifestPath: string;
  private readonly client: RemoteVectorStoreClient;
  private manifest!: RemoteManifest;
  private vectorStoreId: string | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private pendingSync: Promise<void> | null = null;
  private closed = false;
  private fileCount = 0;

  private constructor(params: {
    cfg: OpenClawConfig;
    agentId: string;
    remote: ResolvedRemoteConfig;
  }) {
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.remote = params.remote;
    this.workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const stateDir = resolveStateDir(process.env, os.homedir);
    this.manifestPath = path.join(stateDir, "memory", `${params.agentId}-remote-manifest.json`);
    this.client = new RemoteVectorStoreClient({
      baseUrl: params.remote.baseUrl,
      apiKey: params.remote.apiKey,
      headers: params.remote.headers,
    });
  }

  private async initialize(mode: RemoteManagerMode): Promise<void> {
    await this.ensureVectorStore();
    this.manifest = await RemoteManifest.load(this.manifestPath, this.vectorStoreId!);

    if (mode === "status") {
      return;
    }

    const initialSync = this.runSync({ reason: "boot" });
    void initialSync.catch((err) => {
      log.warn(`remote memory boot sync failed: ${String(err)}`);
    });

    if (this.remote.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        void this.runSync({ reason: "interval" }).catch((err) => {
          log.warn(`remote memory sync failed: ${String(err)}`);
        });
      }, this.remote.syncIntervalMs);
      this.syncTimer.unref();
    }
  }

  private async ensureVectorStore(): Promise<void> {
    if (this.remote.vectorStoreId) {
      try {
        const store = await this.client.getVectorStore(this.remote.vectorStoreId);
        this.vectorStoreId = store.id;
        this.fileCount = store.file_counts?.total ?? 0;
        return;
      } catch (err) {
        log.warn(`configured vector store ${this.remote.vectorStoreId} not found: ${String(err)}`);
      }
    }

    const existing = await this.client.listVectorStores(100);
    const match = existing.data?.find((s) => s.name === this.remote.vectorStoreName);
    if (match) {
      this.vectorStoreId = match.id;
      this.fileCount = match.file_counts?.total ?? 0;
      return;
    }

    const created = await this.client.createVectorStore(this.remote.vectorStoreName);
    this.vectorStoreId = created.id;
    this.fileCount = 0;
    log.info(`created remote vector store "${this.remote.vectorStoreName}" (${created.id})`);
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed || !this.vectorStoreId) {
      return [];
    }

    if (this.pendingSync) {
      await Promise.race([
        this.pendingSync.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }

    const maxResults = opts?.maxResults ?? this.remote.searchMaxResults;
    const scoreThreshold = opts?.minScore ?? this.remote.searchScoreThreshold;

    const results = await this.client.searchVectorStore(this.vectorStoreId, trimmed, {
      maxResults,
      scoreThreshold,
    });

    const mapped: MemorySearchResult[] = [];
    for (const hit of results) {
      const text = extractSearchResultText(hit.content);
      const resolved = await this.resolveLineNumbers(hit.filename, text);
      mapped.push({
        path: resolved.relPath,
        startLine: resolved.startLine,
        endLine: resolved.endLine,
        score: hit.score,
        snippet: text,
        source: "memory",
      });
    }
    return mapped;
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (params?.progress) {
      params.progress({ completed: 0, total: 1, label: "Syncing to remote vector store..." });
    }
    await this.runSync({ reason: params?.reason ?? "manual", force: params?.force });
    if (params?.progress) {
      params.progress({ completed: 1, total: 1, label: "Remote sync complete" });
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const relPath = params.relPath?.trim();
    if (!relPath) {
      throw new Error("path required");
    }
    const resolved = path.resolve(this.workspaceDir, relPath);
    if (!this.isWithinWorkspace(resolved)) {
      throw new Error("path escapes workspace");
    }
    // Use realpath to resolve symlinks, then re-check containment
    const absPath = await fs.realpath(resolved);
    if (!this.isWithinWorkspace(absPath)) {
      throw new Error("path escapes workspace via symlink");
    }
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      throw new Error("path required");
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (params.from === undefined && params.lines === undefined) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "remote",
      provider: "remote",
      model: undefined,
      requestedProvider: "remote",
      files: this.fileCount,
      chunks: 0,
      dirty: false,
      workspaceDir: this.workspaceDir,
      dbPath: this.manifestPath,
      sources: ["memory"],
      vector: { enabled: true, available: true },
      batch: {
        enabled: false,
        failures: 0,
        limit: 0,
        wait: false,
        concurrency: 0,
        pollIntervalMs: 0,
        timeoutMs: 0,
      },
      custom: {
        remote: {
          baseUrl: this.remote.baseUrl,
          vectorStoreId: this.vectorStoreId,
          vectorStoreName: this.remote.vectorStoreName,
        },
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const ok = await this.client.healthCheck();
    return ok ? { ok: true } : { ok: false, error: "remote vector store unreachable" };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    await this.pendingSync?.catch(() => undefined);
  }

  private async runSync(params: { reason: string; force?: boolean }): Promise<void> {
    if (this.closed || !this.vectorStoreId) {
      return;
    }
    if (this.pendingSync) {
      if (!params.force) {
        return this.pendingSync;
      }
      await this.pendingSync.catch(() => undefined);
    }

    const run = async () => {
      const localFiles = await listMemoryFiles(this.workspaceDir);
      const activeRelPaths = new Set<string>();

      let uploaded = 0;
      for (const absPath of localFiles) {
        const ext = path.extname(absPath).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          continue;
        }

        const entry = await buildFileEntry(absPath, this.workspaceDir);
        if (!entry) {
          continue;
        }
        activeRelPaths.add(entry.path);

        const existing = this.manifest.getEntry(entry.path);
        if (existing && existing.hash === entry.hash) {
          continue;
        }

        try {
          if (existing) {
            await this.client.detachFile(this.vectorStoreId!, existing.fileId).catch(() => {});
          }

          const content = await fs.readFile(absPath, "utf-8");
          const filename = path.basename(absPath);
          const fileRecord = await this.client.uploadFile(filename, content);
          const attached = await this.client.attachFile(this.vectorStoreId!, fileRecord.id);

          this.manifest.upsert({
            path: entry.path,
            hash: entry.hash,
            fileId: fileRecord.id,
            vectorStoreFileId: attached.id,
            uploadedAt: Date.now(),
          });
          uploaded++;
        } catch (err) {
          log.warn(`failed to sync file ${entry.path} to remote: ${String(err)}`);
        }
      }

      const staleEntries = this.manifest.getAllEntries().filter((e) => !activeRelPaths.has(e.path));
      for (const stale of staleEntries) {
        try {
          await this.client.detachFile(this.vectorStoreId!, stale.fileId);
        } catch {
          // already detached or store changed
        }
        this.manifest.remove(stale.path);
      }

      await this.manifest.save();

      this.fileCount = this.manifest.getAllEntries().length;

      if (uploaded > 0 || staleEntries.length > 0) {
        log.info(
          `remote sync (${params.reason}): uploaded=${uploaded}, removed=${staleEntries.length}, total=${this.fileCount}`,
        );
      }
    };

    this.pendingSync = run().finally(() => {
      this.pendingSync = null;
    });
    await this.pendingSync;
  }

  private async resolveLineNumbers(
    filename: string,
    chunkContent: string,
  ): Promise<{ relPath: string; startLine: number; endLine: number }> {
    const entry = this.manifest.getAllEntries().find((e) => {
      const base = path.basename(e.path);
      return base === filename || e.path === filename;
    });

    const relPath = entry?.path ?? filename;

    if (!chunkContent.trim()) {
      return { relPath, startLine: 1, endLine: 1 };
    }

    try {
      const absPath = path.resolve(this.workspaceDir, relPath);
      const content = await fs.readFile(absPath, "utf-8");
      const searchText = chunkContent.trim().split("\n")[0];
      const idx = content.indexOf(searchText);
      if (idx >= 0) {
        const before = content.slice(0, idx);
        const startLine = before.split("\n").length;
        const chunkLines = chunkContent.split("\n").length;
        return { relPath, startLine, endLine: startLine + chunkLines - 1 };
      }
    } catch {
      // file not found locally or other error
    }

    const chunkLines = chunkContent.split("\n").length;
    return { relPath, startLine: 1, endLine: chunkLines };
  }

  private isWithinWorkspace(absPath: string): boolean {
    const normalized = path.normalize(absPath);
    const normalizedWorkspace = path.normalize(
      this.workspaceDir.endsWith(path.sep) ? this.workspaceDir : `${this.workspaceDir}${path.sep}`,
    );
    return (
      normalized === path.normalize(this.workspaceDir) || normalized.startsWith(normalizedWorkspace)
    );
  }
}

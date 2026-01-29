import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MoltbotConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MemorySearchResult } from "./index.js";
import { CogneeClient, type CogneeClientConfig, type CogneeSearchResult } from "./cognee-client.js";
import {
  buildFileEntry,
  hashText,
  listMemoryFiles,
  isMemoryPath,
  normalizeRelPath,
  type MemoryFileEntry,
} from "./internal.js";

const log = createSubsystemLogger("cognee-provider");

const DEFAULT_DATASET_NAME = "clawdbot";
const DEFAULT_SEARCH_TYPE = "GRAPH_COMPLETION";
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_AUTO_COGNIFY = true;
const DEFAULT_COGNIFY_BATCH_SIZE = 100;
const SNIPPET_MAX_CHARS = 700;

type CogneeSyncIndex = {
  datasetId?: string;
  datasetName?: string;
  files: Record<string, { hash: string; dataId?: string }>;
};

export type CogneeProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  datasetName?: string;
  searchType?: "GRAPH_COMPLETION" | "chunks" | "summaries";
  maxResults?: number;
  timeoutSeconds?: number;
  autoCognify?: boolean;
  cognifyBatchSize?: number;
};

export type CogneeMemorySource = "memory" | "sessions";

export class CogneeMemoryProvider {
  private readonly client: CogneeClient;
  private readonly cfg: MoltbotConfig;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly datasetName: string;
  private readonly searchType: "GRAPH_COMPLETION" | "chunks" | "summaries";
  private readonly maxResults: number;
  private readonly autoCognify: boolean;
  private readonly cognifyBatchSize: number;
  private readonly sources: Set<CogneeMemorySource>;
  private datasetId?: string;
  private syncedFiles = new Map<string, string>(); // path -> hash
  private readonly syncIndexPath: string;
  private syncIndexLoaded = false;
  private syncIndex: CogneeSyncIndex = { files: {} };
  private syncIndexDirty = false;

  constructor(
    cfg: MoltbotConfig,
    agentId: string,
    sources: Array<CogneeMemorySource>,
    config: CogneeProviderConfig = {},
  ) {
    const timeoutMs = (config.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000;
    const clientConfig: CogneeClientConfig = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeoutMs,
    };

    this.client = new CogneeClient(clientConfig);
    this.cfg = cfg;
    this.agentId = agentId;
    this.workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    this.datasetName = config.datasetName || DEFAULT_DATASET_NAME;
    this.searchType = config.searchType || DEFAULT_SEARCH_TYPE;
    this.maxResults = config.maxResults || DEFAULT_MAX_RESULTS;
    this.autoCognify = config.autoCognify ?? DEFAULT_AUTO_COGNIFY;
    this.cognifyBatchSize = config.cognifyBatchSize || DEFAULT_COGNIFY_BATCH_SIZE;
    this.sources = new Set(sources);
    this.syncIndexPath = path.join(
      resolveStateDir(process.env, os.homedir),
      "memory",
      "cognee",
      `${agentId}.json`,
    );

    log.info("Cognee memory provider initialized", {
      agentId,
      datasetName: this.datasetName,
      searchType: this.searchType,
      sources: Array.from(this.sources),
    });
  }

  async healthCheck(): Promise<boolean> {
    return await this.client.healthCheck();
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    update?: boolean;
    progress?: (update: { completed: number; total: number; label?: string }) => void;
  }): Promise<void> {
    log.info("Starting Cognee memory sync", { agentId: this.agentId });

    let addedCount = 0;
    await this.loadSyncIndex();
    const force = Boolean(params?.force);
    const update = Boolean(params?.update);

    // Sync memory files
    if (this.sources.has("memory")) {
      const memoryFiles = await this.collectMemoryFiles();
      addedCount += await this.syncFiles(memoryFiles, "memory", { update });
    }

    // Sync session transcripts
    if (this.sources.has("sessions")) {
      const sessionFiles = await this.collectSessionFiles();
      addedCount += await this.syncFiles(sessionFiles, "sessions", { update });
    }

    // Run cognify if auto-enabled and files were added
    if ((this.autoCognify && addedCount > 0) || (this.autoCognify && force)) {
      log.info("Running cognify after sync", { addedCount });
      await this.cognify();
    }

    if (this.syncIndexDirty) {
      await this.saveSyncIndex();
    }

    log.info("Cognee memory sync completed", {
      agentId: this.agentId,
      addedCount,
    });

    if (params?.progress) {
      params.progress({
        completed: addedCount,
        total: addedCount,
        label: params.reason ? `Synced (${params.reason})` : "Synced",
      });
    }
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    log.debug("Searching Cognee memory", { query, searchType: this.searchType });

    try {
      const response = await this.client.search({
        queryText: query,
        searchType: this.searchType,
        datasetIds: this.datasetId ? [this.datasetId] : undefined,
      });

      const maxResults = opts?.maxResults ?? this.maxResults;
      const minScore = opts?.minScore ?? 0;
      const results: MemorySearchResult[] = response.results
        .map((r) => this.transformResult(r))
        .filter((r) => r.score >= minScore)
        .slice(0, maxResults);

      log.debug("Cognee search completed", { query, resultCount: results.length });
      return results;
    } catch (error) {
      log.error("Cognee search failed", { error, query });
      throw error;
    }
  }

  async cognify(): Promise<void> {
    try {
      const response = await this.client.cognify({
        datasetIds: this.datasetId ? [this.datasetId] : undefined,
      });
      log.info("Cognify completed", { status: response.status });
    } catch (error) {
      log.error("Cognify failed", { error });
      throw error;
    }
  }

  async getStatus(): Promise<{
    connected: boolean;
    datasetId?: string;
    datasetName: string;
    syncedFileCount: number;
    version?: string;
  }> {
    try {
      const status = await this.client.status();
      const dataset = status.datasets?.find((d) => d.name === this.datasetName);

      return {
        connected: true,
        datasetId: this.datasetId || dataset?.id,
        datasetName: this.datasetName,
        syncedFileCount: this.syncedFiles.size,
        version: status.version,
      };
    } catch (error) {
      log.error("Failed to get Cognee status", { error });
      return {
        connected: false,
        datasetName: this.datasetName,
        syncedFileCount: this.syncedFiles.size,
      };
    }
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
    sources: Array<CogneeMemorySource>;
    sourceCounts: Array<{ source: CogneeMemorySource; files: number; chunks: number }>;
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
    batch?: {
      enabled: boolean;
      failures: number;
      limit: number;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMs: number;
      lastError?: string;
      lastProvider?: string;
    };
  } {
    const sources = Array.from(this.sources);
    const files = this.syncedFiles.size;
    return {
      files,
      chunks: 0,
      dirty: false,
      workspaceDir: this.workspaceDir,
      dbPath: "cognee",
      provider: "cognee",
      model: this.searchType,
      requestedProvider: "cognee",
      sources,
      sourceCounts: sources.map((source) => ({ source, files, chunks: 0 })),
      vector: {
        enabled: false,
        available: false,
      },
      fts: {
        enabled: false,
        available: false,
      },
    };
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

  async probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Cognee provider does not use embeddings." };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {}

  private async loadSyncIndex(): Promise<void> {
    if (this.syncIndexLoaded) return;
    this.syncIndexLoaded = true;
    try {
      const raw = await fs.readFile(this.syncIndexPath, "utf-8");
      const parsed = JSON.parse(raw) as CogneeSyncIndex;
      if (!parsed || typeof parsed !== "object") return;
      this.syncIndex = {
        datasetId: parsed.datasetId,
        datasetName: parsed.datasetName,
        files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn("Failed to load Cognee sync index", { error });
      }
    }

    if (this.syncIndex.datasetName && this.syncIndex.datasetName !== this.datasetName) {
      log.info("Resetting Cognee sync index (dataset name changed)", {
        from: this.syncIndex.datasetName,
        to: this.datasetName,
      });
      this.syncIndex = { files: {} };
      this.syncIndexDirty = true;
    }

    if (this.syncIndex.datasetId && this.datasetId && this.syncIndex.datasetId !== this.datasetId) {
      log.info("Resetting Cognee sync index (dataset id changed)", {
        from: this.syncIndex.datasetId,
        to: this.datasetId,
      });
      this.syncIndex = { files: {} };
      this.syncIndexDirty = true;
    }

    if (!this.datasetId && this.syncIndex.datasetId) {
      this.datasetId = this.syncIndex.datasetId;
    }
  }

  private async saveSyncIndex(): Promise<void> {
    const dir = path.dirname(this.syncIndexPath);
    await fs.mkdir(dir, { recursive: true });
    const payload: CogneeSyncIndex = {
      datasetId: this.datasetId ?? this.syncIndex.datasetId,
      datasetName: this.datasetName,
      files: this.syncIndex.files,
    };
    await fs.writeFile(this.syncIndexPath, JSON.stringify(payload, null, 2), "utf-8");
    this.syncIndexDirty = false;
  }

  private async collectMemoryFiles(): Promise<MemoryFileEntry[]> {
    const files: MemoryFileEntry[] = [];
    const memoryPaths = await listMemoryFiles(this.workspaceDir);

    for (const absPath of memoryPaths) {
      try {
        const entry = await buildFileEntry(absPath, this.workspaceDir);
        files.push(entry);
      } catch (error) {
        log.warn("Failed to process memory file", { absPath, error });
      }
    }

    return files;
  }

  private async collectSessionFiles(): Promise<MemoryFileEntry[]> {
    const files: MemoryFileEntry[] = [];
    const transcriptsDir = resolveSessionTranscriptsDirForAgent(this.agentId);

    try {
      const entries = await fs.readdir(transcriptsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

        const absPath = path.join(transcriptsDir, entry.name);
        try {
          const stat = await fs.stat(absPath);
          const content = await fs.readFile(absPath, "utf-8");
          const hash = hashText(content);

          files.push({
            path: `sessions/${entry.name}`,
            absPath,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            hash,
          });
        } catch (error) {
          log.warn("Failed to process session file", { absPath, error });
        }
      }
    } catch (error) {
      log.debug("No session transcripts directory", { transcriptsDir, error });
    }

    return files;
  }

  private async syncFiles(
    files: MemoryFileEntry[],
    source: CogneeMemorySource,
    opts?: { update?: boolean },
  ): Promise<number> {
    let addedCount = 0;
    const batchSize = this.cognifyBatchSize;
    const update = Boolean(opts?.update);

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      for (const file of batch) {
        const existingHash = this.syncedFiles.get(file.path);
        if (existingHash === file.hash) {
          log.debug("Skipping unchanged file", { path: file.path });
          continue;
        }

        try {
          const content = await fs.readFile(file.absPath, "utf-8");
          const metadata = {
            path: file.path,
            source,
            agentId: this.agentId,
            size: file.size,
            mtimeMs: file.mtimeMs,
          };

          const dataWithMetadata = `# ${file.path}\n\n${content}\n\n---\nMetadata: ${JSON.stringify(metadata)}`;

          const record = this.syncIndex.files[file.path];
          const datasetId = this.datasetId ?? this.syncIndex.datasetId;
          const canUpdate = update && record?.dataId && datasetId;

          if (canUpdate && datasetId && record?.dataId) {
            await this.client.update({
              dataId: record.dataId,
              datasetId,
              data: dataWithMetadata,
            });
            addedCount++;
            log.debug("Updated file in Cognee", {
              path: file.path,
              datasetId,
              dataId: record.dataId,
            });
          } else {
            const response = await this.client.add({
              data: dataWithMetadata,
              datasetName: this.datasetName,
              datasetId,
            });

            if (!this.datasetId) {
              this.datasetId = response.datasetId;
            }
            if (response.dataId) {
              this.syncIndex.files[file.path] = {
                hash: file.hash,
                dataId: response.dataId,
              };
            } else {
              this.syncIndex.files[file.path] = { hash: file.hash };
            }
            this.syncIndex.datasetId = this.datasetId ?? this.syncIndex.datasetId;
            this.syncIndex.datasetName = this.datasetName;
            this.syncIndexDirty = true;

            this.syncedFiles.set(file.path, file.hash);
            addedCount++;

            log.debug("Added file to Cognee", {
              path: file.path,
              datasetId: response.datasetId,
            });
            continue;
          }

          const dataId = record?.dataId;
          this.syncIndex.files[file.path] = { hash: file.hash, dataId };
          this.syncIndex.datasetId = datasetId ?? this.syncIndex.datasetId;
          this.syncIndex.datasetName = this.datasetName;
          this.syncIndexDirty = true;
          this.syncedFiles.set(file.path, file.hash);
        } catch (error) {
          log.error("Failed to sync file to Cognee", { path: file.path, error });
        }
      }
    }

    return addedCount;
  }

  private transformResult(result: CogneeSearchResult): MemorySearchResult {
    // Extract path from metadata or text
    const metadata = result.metadata || {};
    const path = (metadata.path as string) || "unknown";
    const source = (metadata.source as "memory" | "sessions") || "memory";

    // Truncate snippet to max chars
    let snippet = result.text;
    if (snippet.length > SNIPPET_MAX_CHARS) {
      snippet = snippet.slice(0, SNIPPET_MAX_CHARS) + "...";
    }

    return {
      path,
      startLine: 0, // Cognee doesn't provide line numbers
      endLine: 0,
      score: result.score,
      snippet,
      source,
    };
  }
}

export async function createCogneeProvider(
  cfg: MoltbotConfig,
  agentId: string,
  sources: Array<CogneeMemorySource>,
  config: CogneeProviderConfig = {},
): Promise<CogneeMemoryProvider> {
  const provider = new CogneeMemoryProvider(cfg, agentId, sources, config);

  // Verify connection
  const healthy = await provider.healthCheck();
  if (!healthy) {
    throw new Error(
      `Failed to connect to Cognee at ${config.baseUrl || "http://localhost:8000"}. ` +
        `Ensure Cognee is running (see docs/memory-cognee.md for setup).`,
    );
  }

  return provider;
}

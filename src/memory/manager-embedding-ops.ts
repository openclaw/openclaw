import fs from "node:fs/promises";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./batch-gemini.js";
import {
  OPENAI_BATCH_ENDPOINT,
  type OpenAiBatchRequest,
  runOpenAiEmbeddingBatches,
} from "./batch-openai.js";
import { type VoyageBatchRequest, runVoyageEmbeddingBatches } from "./batch-voyage.js";
import { enforceEmbeddingMaxInputTokens } from "./embedding-chunk-limits.js";
import { estimateUtf8Bytes } from "./embedding-input-limits.js";
import {
  chunkMarkdown,
  hashText,
  parseEmbedding,
  remapChunkLines,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";
import type { SessionFileEntry } from "./session-files.js";
import type { MemorySource } from "./types.js";

const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const BATCH_FAILURE_LIMIT = 2;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

const log = createSubsystemLogger("memory");

export abstract class MemoryManagerEmbeddingOps extends MemoryManagerSyncOps {
  protected abstract batchFailureCount: number;
  protected abstract batchFailureLastError?: string;
  protected abstract batchFailureLastProvider?: string;
  protected abstract batchFailureLock: Promise<void>;

  private buildEmbeddingBatches(chunks: MemoryChunk[]): MemoryChunk[][] {
    const batches: MemoryChunk[][] = [];
    let current: MemoryChunk[] = [];
    let currentTokens = 0;

    for (const chunk of chunks) {
      const estimate = estimateUtf8Bytes(chunk.text);
      const wouldExceed =
        current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS;
      if (wouldExceed) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
        batches.push([chunk]);
        continue;
      }
      current.push(chunk);
      currentTokens += estimate;
    }

    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    if (!this.cache.enabled || !this.provider) {
      return new Map();
    }
    if (hashes.length === 0) {
      return new Map();
    }
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const hash of hashes) {
      if (!hash) {
        continue;
      }
      if (seen.has(hash)) {
        continue;
      }
      seen.add(hash);
      unique.push(hash);
    }
    if (unique.length === 0) {
      return new Map();
    }

    const out = new Map<string, number[]>();
    const baseParams = [this.provider.id, this.provider.model, this.providerKey];
    const batchSize = 400;
    for (let start = 0; start < unique.length; start += batchSize) {
      const batch = unique.slice(start, start + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
            ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
        )
        .all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;
      for (const row of rows) {
        out.set(row.hash, parseEmbedding(row.embedding));
      }
    }
    return out;
  }

  private upsertEmbeddingCache(entries: Array<{ hash: string; embedding: number[] }>): void {
    if (!this.cache.enabled || !this.provider) {
      return;
    }
    if (entries.length === 0) {
      return;
    }
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
        ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
        ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
        `   embedding=excluded.embedding,\n` +
        `   dims=excluded.dims,\n` +
        `   updated_at=excluded.updated_at`,
    );
    for (const entry of entries) {
      const embedding = entry.embedding ?? [];
      stmt.run(
        this.provider.id,
        this.provider.model,
        this.providerKey,
        entry.hash,
        JSON.stringify(embedding),
        embedding.length,
        now,
      );
    }
  }

  protected pruneEmbeddingCacheIfNeeded(): void {
    if (!this.cache.enabled) {
      return;
    }
    const max = this.cache.maxEntries;
    if (!max || max <= 0) {
      return;
    }
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
      | { c: number }
      | undefined;
    const count = row?.c ?? 0;
    if (count <= max) {
      return;
    }
    const excess = count - max;
    this.db
      .prepare(
        `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE rowid IN (\n` +
          `   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}\n` +
          `   ORDER BY updated_at ASC\n` +
          `   LIMIT ?\n` +
          ` )`,
      )
      .run(excess);
  }

  private async embedChunksInBatches(chunks: MemoryChunk[]): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);

    if (missing.length === 0) {
      return embeddings;
    }

    const missingChunks = missing.map((m) => m.chunk);
    const batches = this.buildEmbeddingBatches(missingChunks);
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    let cursor = 0;
    for (const batch of batches) {
      const batchEmbeddings = await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
          toCache.push({ hash: item.chunk.hash, embedding });
        }
      }
      cursor += batch.length;
    }
    this.upsertEmbeddingCache(toCache);
    return embeddings;
  }

  protected computeProviderKey(): string {
    // FTS-only mode: no provider, use a constant key
    if (!this.provider) {
      return hashText(JSON.stringify({ provider: "none", model: "fts-only" }));
    }
    if (this.provider.id === "openai" && this.openAi) {
      const entries = Object.entries(this.openAi.headers)
        .filter(([key]) => key.toLowerCase() !== "authorization")
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value]);
      return hashText(
        JSON.stringify({
          provider: "openai",
          baseUrl: this.openAi.baseUrl,
          model: this.openAi.model,
          headers: entries,
        }),
      );
    }
    if (this.provider.id === "gemini" && this.gemini) {
      const entries = Object.entries(this.gemini.headers)
        .filter(([key]) => {
          const lower = key.toLowerCase();
          return lower !== "authorization" && lower !== "x-goog-api-key";
        })
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value]);
      return hashText(
        JSON.stringify({
          provider: "gemini",
          baseUrl: this.gemini.baseUrl,
          model: this.gemini.model,
          headers: entries,
        }),
      );
    }
    return hashText(JSON.stringify({ provider: this.provider.id, model: this.provider.model }));
  }

  private async embedChunksWithBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    if (!this.provider) {
      return this.embedChunksInBatches(chunks);
    }
    if (this.provider.id === "openai" && this.openAi) {
      return this.embedChunksWithOpenAiBatch(chunks, entry, source);
    }
    if (this.provider.id === "gemini" && this.gemini) {
      return this.embedChunksWithGeminiBatch(chunks, entry, source);
    }
    if (this.provider.id === "voyage" && this.voyage) {
      return this.embedChunksWithVoyageBatch(chunks, entry, source);
    }
    return this.embedChunksInBatches(chunks);
  }

  private collectCachedEmbeddings(chunks: MemoryChunk[]): {
    embeddings: number[][];
    missing: Array<{ index: number; chunk: MemoryChunk }>;
  } {
    const cached = this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
    const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
    const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
      if (hit && hit.length > 0) {
        embeddings[i] = hit;
      } else if (chunk) {
        missing.push({ index: i, chunk });
      }
    }

    return { embeddings, missing };
  }

  private buildBatchCustomId(params: {
    source: MemorySource;
    entry: MemoryFileEntry | SessionFileEntry;
    chunk: MemoryChunk;
    index: number;
  }): string {
    return hashText(
      `${params.source}:${params.entry.path}:${params.chunk.startLine}:${params.chunk.endLine}:${params.chunk.hash}:${params.index}`,
    );
  }

  private buildBatchRequests<T extends { custom_id: string }>(params: {
    missing: Array<{ index: number; chunk: MemoryChunk }>;
    entry: MemoryFileEntry | SessionFileEntry;
    source: MemorySource;
    build: (chunk: MemoryChunk) => Omit<T, "custom_id">;
  }): { requests: T[]; mapping: Map<string, { index: number; hash: string }> } {
    const requests: T[] = [];
    const mapping = new Map<string, { index: number; hash: string }>();

    for (const item of params.missing) {
      const chunk = item.chunk;
      const customId = this.buildBatchCustomId({
        source: params.source,
        entry: params.entry,
        chunk,
        index: item.index,
      });
      mapping.set(customId, { index: item.index, hash: chunk.hash });
      const built = params.build(chunk);
      requests.push({ custom_id: customId, ...built } as T);
    }

    return { requests, mapping };
  }

  private applyBatchEmbeddings(params: {
    byCustomId: Map<string, number[]>;
    mapping: Map<string, { index: number; hash: string }>;
    embeddings: number[][];
  }): void {
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    for (const [customId, embedding] of params.byCustomId.entries()) {
      const mapped = params.mapping.get(customId);
      if (!mapped) {
        continue;
      }
      params.embeddings[mapped.index] = embedding;
      toCache.push({ hash: mapped.hash, embedding });
    }
    this.upsertEmbeddingCache(toCache);
  }

  private buildEmbeddingBatchRunnerOptions<TRequest>(params: {
    requests: TRequest[];
    chunks: MemoryChunk[];
    source: MemorySource;
  }): {
    agentId: string;
    requests: TRequest[];
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    debug: (message: string, data?: Record<string, unknown>) => void;
  } {
    const { requests, chunks, source } = params;
    return {
      agentId: this.agentId,
      requests,
      wait: this.batch.wait,
      concurrency: this.batch.concurrency,
      pollIntervalMs: this.batch.pollIntervalMs,
      timeoutMs: this.batch.timeoutMs,
      debug: (message, data) =>
        log.debug(
          message,
          data ? { ...data, source, chunks: chunks.length } : { source, chunks: chunks.length },
        ),
    };
  }

  private async embedChunksWithProviderBatch<TRequest extends { custom_id: string }>(params: {
    chunks: MemoryChunk[];
    entry: MemoryFileEntry | SessionFileEntry;
    source: MemorySource;
    provider: "voyage" | "openai" | "gemini";
    enabled: boolean;
    buildRequest: (chunk: MemoryChunk) => Omit<TRequest, "custom_id">;
    runBatch: (runnerOptions: {
      agentId: string;
      requests: TRequest[];
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMs: number;
      debug: (message: string, data?: Record<string, unknown>) => void;
    }) => Promise<Map<string, number[]> | number[][]>;
  }): Promise<number[][]> {
    if (!params.enabled) {
      return this.embedChunksInBatches(params.chunks);
    }
    if (params.chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(params.chunks);
    if (missing.length === 0) {
      return embeddings;
    }

    const { requests, mapping } = this.buildBatchRequests<TRequest>({
      missing,
      entry: params.entry,
      source: params.source,
      build: params.buildRequest,
    });
    const runnerOptions = this.buildEmbeddingBatchRunnerOptions({
      requests,
      chunks: params.chunks,
      source: params.source,
    });
    const batchResult = await this.runBatchWithFallback({
      provider: params.provider,
      run: async () => await params.runBatch(runnerOptions),
      fallback: async () => await this.embedChunksInBatches(params.chunks),
    });
    if (Array.isArray(batchResult)) {
      return batchResult;
    }
    this.applyBatchEmbeddings({ byCustomId: batchResult, mapping, embeddings });
    return embeddings;
  }

  private async embedChunksWithVoyageBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const voyage = this.voyage;
    return await this.embedChunksWithProviderBatch<VoyageBatchRequest>({
      chunks,
      entry,
      source,
      provider: "voyage",
      enabled: Boolean(voyage),
      buildRequest: (chunk) => ({
        body: { input: chunk.text },
      }),
      runBatch: async (runnerOptions) =>
        await runVoyageEmbeddingBatches({
          client: voyage!,
          ...runnerOptions,
        }),
    });
  }

  private async embedChunksWithOpenAiBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const openAi = this.openAi;
    return await this.embedChunksWithProviderBatch<OpenAiBatchRequest>({
      chunks,
      entry,
      source,
      provider: "openai",
      enabled: Boolean(openAi),
      buildRequest: (chunk) => ({
        method: "POST",
        url: OPENAI_BATCH_ENDPOINT,
        body: {
          model: openAi?.model ?? this.provider?.model ?? "text-embedding-3-small",
          input: chunk.text,
        },
      }),
      runBatch: async (runnerOptions) =>
        await runOpenAiEmbeddingBatches({
          openAi: openAi!,
          ...runnerOptions,
        }),
    });
  }

  private async embedChunksWithGeminiBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const gemini = this.gemini;
    return await this.embedChunksWithProviderBatch<GeminiBatchRequest>({
      chunks,
      entry,
      source,
      provider: "gemini",
      enabled: Boolean(gemini),
      buildRequest: (chunk) => ({
        content: { parts: [{ text: chunk.text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      }),
      runBatch: async (runnerOptions) =>
        await runGeminiEmbeddingBatches({
          gemini: gemini!,
          ...runnerOptions,
        }),
    });
  }

  protected async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    if (!this.provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    let attempt = 0;
    let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
    while (true) {
      try {
        const timeoutMs = this.resolveEmbeddingTimeout("batch");
        log.debug("memory embeddings: batch start", {
          provider: this.provider.id,
          items: texts.length,
          timeoutMs,
        });
        return await this.withTimeout(
          this.provider.embedBatch(texts),
          timeoutMs,
          `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
          throw err;
        }
        const waitMs = Math.min(
          EMBEDDING_RETRY_MAX_DELAY_MS,
          Math.round(delayMs * (1 + Math.random() * 0.2)),
        );
        log.warn(`memory embeddings rate limited; retrying in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        delayMs *= 2;
        attempt += 1;
      }
    }
  }

  private isRetryableEmbeddingError(message: string): boolean {
    return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare)/i.test(
      message,
    );
  }

  private resolveEmbeddingTimeout(kind: "query" | "batch"): number {
    const isLocal = this.provider?.id === "local";
    if (kind === "query") {
      return isLocal ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
    }
    return isLocal ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
  }

  protected async embedQueryWithTimeout(text: string): Promise<number[]> {
    if (!this.provider) {
      throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
    }
    const timeoutMs = this.resolveEmbeddingTimeout("query");
    log.debug("memory embeddings: query start", { provider: this.provider.id, timeoutMs });
    return await this.withTimeout(
      this.provider.embedQuery(text),
      timeoutMs,
      `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return (await Promise.race([promise, timeoutPromise])) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async withBatchFailureLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const wait = this.batchFailureLock;
    this.batchFailureLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private async resetBatchFailureCount(): Promise<void> {
    await this.withBatchFailureLock(async () => {
      if (this.batchFailureCount > 0) {
        log.debug("memory embeddings: batch recovered; resetting failure count");
      }
      this.batchFailureCount = 0;
      this.batchFailureLastError = undefined;
      this.batchFailureLastProvider = undefined;
    });
  }

  private async recordBatchFailure(params: {
    provider: string;
    message: string;
    attempts?: number;
    forceDisable?: boolean;
  }): Promise<{ disabled: boolean; count: number }> {
    return await this.withBatchFailureLock(async () => {
      if (!this.batch.enabled) {
        return { disabled: true, count: this.batchFailureCount };
      }
      const increment = params.forceDisable
        ? BATCH_FAILURE_LIMIT
        : Math.max(1, params.attempts ?? 1);
      this.batchFailureCount += increment;
      this.batchFailureLastError = params.message;
      this.batchFailureLastProvider = params.provider;
      const disabled = params.forceDisable || this.batchFailureCount >= BATCH_FAILURE_LIMIT;
      if (disabled) {
        this.batch.enabled = false;
      }
      return { disabled, count: this.batchFailureCount };
    });
  }

  private isBatchTimeoutError(message: string): boolean {
    return /timed out|timeout/i.test(message);
  }

  private async runBatchWithTimeoutRetry<T>(params: {
    provider: string;
    run: () => Promise<T>;
  }): Promise<T> {
    try {
      return await params.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isBatchTimeoutError(message)) {
        log.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
        try {
          return await params.run();
        } catch (retryErr) {
          (retryErr as { batchAttempts?: number }).batchAttempts = 2;
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async runBatchWithFallback<T>(params: {
    provider: string;
    run: () => Promise<T>;
    fallback: () => Promise<number[][]>;
  }): Promise<T | number[][]> {
    if (!this.batch.enabled) {
      return await params.fallback();
    }
    try {
      const result = await this.runBatchWithTimeoutRetry({
        provider: params.provider,
        run: params.run,
      });
      await this.resetBatchFailureCount();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = (err as { batchAttempts?: number }).batchAttempts ?? 1;
      const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
      const failure = await this.recordBatchFailure({
        provider: params.provider,
        message,
        attempts,
        forceDisable,
      });
      const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
      log.warn(
        `memory embeddings: ${params.provider} batch failed (${failure.count}/${BATCH_FAILURE_LIMIT}); ${suffix}; falling back to non-batch embeddings: ${message}`,
      );
      return await params.fallback();
    }
  }

  protected getIndexConcurrency(): number {
    return this.batch.enabled ? this.batch.concurrency : EMBEDDING_INDEX_CONCURRENCY;
  }

  protected async indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ) {
    // FTS-only mode: skip indexing if no provider
    if (!this.provider) {
      log.debug("Skipping embedding indexing in FTS-only mode", {
        path: entry.path,
        source: options.source,
      });
      return;
    }

    const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
    const chunks = enforceEmbeddingMaxInputTokens(
      this.provider,
      chunkMarkdown(content, this.settings.chunking).filter(
        (chunk) => chunk.text.trim().length > 0,
      ),
    );
    if (options.source === "sessions" && "lineMap" in entry) {
      remapChunkLines(chunks, entry.lineMap);
    }
    const embeddings = this.batch.enabled
      ? await this.embedChunksWithBatch(chunks, entry, options.source)
      : await this.embedChunksInBatches(chunks);
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();
    if (vectorReady) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(entry.path, options.source);
      } catch {}
    }
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(entry.path, options.source, this.provider.model);
      } catch {}
    }
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
        try {
          this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
        } catch {}
        this.db
          .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(id, vectorToBlob(embedding));
      }
      if (this.fts.enabled && this.fts.available) {
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
              ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.text,
            id,
            entry.path,
            options.source,
            this.provider.model,
            chunk.startLine,
            chunk.endLine,
          );
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

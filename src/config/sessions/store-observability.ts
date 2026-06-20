import type {
  SessionStoreAdapter,
  SessionStoreBackendKind,
  SessionStoreEntryBatch,
  SessionStoreListOptions,
  SessionStoreMutationOptions,
  SessionStoreRecord,
  SessionTranscriptChunk,
  SessionTranscriptChunkListOptions,
  SessionTranscriptChunkWriteOptions,
  SessionTurnListOptions,
  SessionTurnRecord,
  SessionTurnWriteOptions,
} from "./storage-adapter.js";
import type { SessionEntry } from "./types.js";

export type SessionStoreOperationName =
  | "loadStore"
  | "readEntry"
  | "listEntries"
  | "saveStore"
  | "writeEntries"
  | "writeTranscriptChunks"
  | "listTranscriptChunks"
  | "writeSessionTurns"
  | "listSessionTurns"
  | "updateStore";

export type SessionStoreOperationMetric = {
  backend: SessionStoreBackendKind;
  operation: SessionStoreOperationName;
  storePath: string;
  ok: boolean;
  startedAtMs: number;
  durationMs: number;
  entryCount?: number;
  chunkCount?: number;
  turnCount?: number;
  byteCount?: number;
  totalCount?: number;
  hasMore?: boolean;
  errorName?: string;
  errorMessage?: string;
};

export type SessionStoreMetricsRecorder = {
  recordSessionStoreOperation(metric: SessionStoreOperationMetric): void | Promise<void>;
};

export type InstrumentSessionStoreAdapterOptions = {
  recorder: SessionStoreMetricsRecorder;
  nowMs?: () => number;
};

export function createInMemorySessionStoreMetricsRecorder(): SessionStoreMetricsRecorder & {
  metrics: SessionStoreOperationMetric[];
} {
  const metrics: SessionStoreOperationMetric[] = [];
  return {
    metrics,
    recordSessionStoreOperation(metric) {
      metrics.push(metric);
    },
  };
}

function errorFields(
  error: unknown,
): Pick<SessionStoreOperationMetric, "errorName" | "errorMessage"> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }
  return {
    errorName: "Error",
    errorMessage: String(error),
  };
}

async function recordMetric(
  recorder: SessionStoreMetricsRecorder,
  metric: SessionStoreOperationMetric,
): Promise<void> {
  await recorder.recordSessionStoreOperation(metric);
}

export function instrumentSessionStoreAdapter(
  adapter: SessionStoreAdapter,
  options: InstrumentSessionStoreAdapterOptions,
): SessionStoreAdapter {
  const nowMs = options.nowMs ?? Date.now;

  async function capture<T>(params: {
    operation: SessionStoreOperationName;
    storePath: string;
    run: () => Promise<T>;
    project?: (
      result: T,
    ) => Pick<
      SessionStoreOperationMetric,
      "entryCount" | "chunkCount" | "turnCount" | "byteCount" | "totalCount" | "hasMore"
    >;
  }): Promise<T> {
    const startedAtMs = nowMs();
    try {
      const result = await params.run();
      await recordMetric(options.recorder, {
        backend: adapter.kind,
        operation: params.operation,
        storePath: params.storePath,
        ok: true,
        startedAtMs,
        durationMs: Math.max(0, nowMs() - startedAtMs),
        ...(params.project ? params.project(result) : {}),
      });
      return result;
    } catch (error) {
      await recordMetric(options.recorder, {
        backend: adapter.kind,
        operation: params.operation,
        storePath: params.storePath,
        ok: false,
        startedAtMs,
        durationMs: Math.max(0, nowMs() - startedAtMs),
        ...errorFields(error),
      });
      throw error;
    }
  }

  const instrumented: SessionStoreAdapter = {
    kind: adapter.kind,
    async loadStore(storePath: string): Promise<SessionStoreRecord> {
      return await capture({
        operation: "loadStore",
        storePath,
        run: () => adapter.loadStore(storePath),
        project: (store) => ({ entryCount: Object.keys(store).length }),
      });
    },
    async readEntry(storePath: string, sessionKey: string): Promise<SessionEntry | undefined> {
      return await capture({
        operation: "readEntry",
        storePath,
        run: () => adapter.readEntry(storePath, sessionKey),
        project: (entry) => ({ entryCount: entry ? 1 : 0 }),
      });
    },
    async listEntries(storePath: string, listOptions?: SessionStoreListOptions) {
      return await capture({
        operation: "listEntries",
        storePath,
        run: () => adapter.listEntries(storePath, listOptions),
        project: (result) => ({
          entryCount: result.entries.length,
          totalCount: result.totalCount,
          hasMore: result.hasMore,
        }),
      });
    },
    async saveStore(
      storePath: string,
      store: SessionStoreRecord,
      mutationOptions?: SessionStoreMutationOptions,
    ): Promise<void> {
      await capture({
        operation: "saveStore",
        storePath,
        run: () => adapter.saveStore(storePath, store, mutationOptions),
        project: () => ({ entryCount: Object.keys(store).length }),
      });
    },
    async updateStore<T>(
      storePath: string,
      mutator: (store: SessionStoreRecord) => T | Promise<T>,
      mutationOptions?: SessionStoreMutationOptions,
    ): Promise<T> {
      return await capture({
        operation: "updateStore",
        storePath,
        run: () => adapter.updateStore(storePath, mutator, mutationOptions),
      });
    },
  };

  if (adapter.writeEntries) {
    instrumented.writeEntries = async (
      storePath: string,
      entries: SessionStoreEntryBatch,
      mutationOptions?: SessionStoreMutationOptions,
    ): Promise<void> => {
      await capture({
        operation: "writeEntries",
        storePath,
        run: () => adapter.writeEntries!(storePath, entries, mutationOptions),
        project: () => ({ entryCount: entries.length }),
      });
    };
  }

  if (adapter.writeTranscriptChunks) {
    instrumented.writeTranscriptChunks = async (
      storePath: string,
      sessionKey: string,
      chunks: readonly SessionTranscriptChunk[],
      options?: SessionTranscriptChunkWriteOptions,
    ): Promise<void> => {
      await capture({
        operation: "writeTranscriptChunks",
        storePath,
        run: () => adapter.writeTranscriptChunks!(storePath, sessionKey, chunks, options),
        project: () => ({
          chunkCount: chunks.length,
          byteCount: chunks.reduce((total, chunk) => total + Math.max(0, chunk.bytes), 0),
        }),
      });
    };
  }

  if (adapter.listTranscriptChunks) {
    instrumented.listTranscriptChunks = async (
      storePath: string,
      sessionKey: string,
      listOptions?: SessionTranscriptChunkListOptions,
    ) => {
      return await capture({
        operation: "listTranscriptChunks",
        storePath,
        run: () => adapter.listTranscriptChunks!(storePath, sessionKey, listOptions),
        project: (result) => ({
          chunkCount: result.chunks.length,
          byteCount: result.chunks.reduce((total, chunk) => total + Math.max(0, chunk.bytes), 0),
          totalCount: result.totalCount,
          hasMore: result.hasMore,
        }),
      });
    };
  }

  if (adapter.writeSessionTurns) {
    instrumented.writeSessionTurns = async (
      storePath: string,
      sessionKey: string,
      turns: readonly SessionTurnRecord[],
      options?: SessionTurnWriteOptions,
    ): Promise<void> => {
      await capture({
        operation: "writeSessionTurns",
        storePath,
        run: () => adapter.writeSessionTurns!(storePath, sessionKey, turns, options),
        project: () => ({ turnCount: turns.length }),
      });
    };
  }

  if (adapter.listSessionTurns) {
    instrumented.listSessionTurns = async (
      storePath: string,
      sessionKey: string,
      listOptions?: SessionTurnListOptions,
    ) => {
      return await capture({
        operation: "listSessionTurns",
        storePath,
        run: () => adapter.listSessionTurns!(storePath, sessionKey, listOptions),
        project: (result) => ({
          turnCount: result.turns.length,
          totalCount: result.totalCount,
          hasMore: result.hasMore,
        }),
      });
    };
  }

  return instrumented;
}

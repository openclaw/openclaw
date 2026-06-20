import type {
  SessionStoreAdapter,
  SessionTranscriptChunk,
  SessionTranscriptChunkListOptions,
} from "./storage-adapter.js";

export type TranscriptChunkReadWindowOptions = {
  adapter: SessionStoreAdapter;
  storePath: string;
  sessionKey: string;
  /** Bounded chunk count to request. Defaults to 10 and is capped at 100. */
  limit?: number;
  /** Zero-based chunk offset after filtering and ordering. */
  offset?: number;
  orderBy?: SessionTranscriptChunkListOptions["orderBy"];
  transcriptPath?: string;
};

export type RecentTranscriptChunkReadWindowOptions = Omit<
  TranscriptChunkReadWindowOptions,
  "orderBy"
>;

export type TranscriptChunkReadWindow = {
  chunks: SessionTranscriptChunk[];
  lines: unknown[];
  totalCount: number;
  limitApplied: number;
  offset: number;
  nextOffset?: number;
  hasMore: boolean;
};

const DEFAULT_TRANSCRIPT_CHUNK_READ_LIMIT = 10;
const MAX_TRANSCRIPT_CHUNK_READ_LIMIT = 100;

function normalizeChunkReadLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_TRANSCRIPT_CHUNK_READ_LIMIT;
  }
  return Math.min(MAX_TRANSCRIPT_CHUNK_READ_LIMIT, Math.max(1, Math.floor(limit)));
}

function normalizeChunkReadOffset(offset: number | undefined): number {
  return typeof offset === "number" && Number.isFinite(offset)
    ? Math.max(0, Math.floor(offset))
    : 0;
}

export function assertTranscriptChunkReadable(
  adapter: SessionStoreAdapter,
): asserts adapter is SessionStoreAdapter &
  Required<Pick<SessionStoreAdapter, "listTranscriptChunks">> {
  if (!adapter.listTranscriptChunks) {
    throw new Error(
      `Session store adapter "${adapter.kind}" does not support transcript chunk reads`,
    );
  }
}

export async function readTranscriptChunkWindow(
  options: TranscriptChunkReadWindowOptions,
): Promise<TranscriptChunkReadWindow> {
  assertTranscriptChunkReadable(options.adapter);
  const limit = normalizeChunkReadLimit(options.limit);
  const offset = normalizeChunkReadOffset(options.offset);
  const result = await options.adapter.listTranscriptChunks(options.storePath, options.sessionKey, {
    limit,
    offset,
    orderBy: options.orderBy ?? "chunkSeq_asc",
    ...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
  });
  const lines = result.chunks.flatMap((chunk) => chunk.chunkJson.lines);
  return {
    chunks: result.chunks,
    lines,
    totalCount: result.totalCount,
    limitApplied: result.limitApplied ?? limit,
    offset: result.offset ?? offset,
    ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
    hasMore: result.hasMore,
  };
}

export async function readRecentTranscriptChunkWindow(
  options: RecentTranscriptChunkReadWindowOptions,
): Promise<TranscriptChunkReadWindow> {
  assertTranscriptChunkReadable(options.adapter);
  const limit = normalizeChunkReadLimit(options.limit);
  const offset = normalizeChunkReadOffset(options.offset);
  const result = await options.adapter.listTranscriptChunks(options.storePath, options.sessionKey, {
    limit,
    offset,
    orderBy: "chunkSeq_desc",
    ...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
  });
  const chunks = result.chunks.toSorted((left, right) => left.chunkSeq - right.chunkSeq);
  const lines = chunks.flatMap((chunk) => chunk.chunkJson.lines);
  return {
    chunks,
    lines,
    totalCount: result.totalCount,
    limitApplied: result.limitApplied ?? limit,
    offset: result.offset ?? offset,
    ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
    hasMore: result.hasMore,
  };
}

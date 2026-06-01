import type {
  ReadRecentSessionMessagesOptions,
  ReadSessionMessagesAsyncOptions,
} from "./session-utils.fs.js";
import {
  readFirstUserMessageFromTranscript as readFirstUserMessageFromTranscriptFile,
  readLatestRecentSessionUsageFromTranscriptAsync as readLatestRecentSessionUsageFromTranscriptAsyncFile,
  readLatestSessionUsageFromTranscript as readLatestSessionUsageFromTranscriptFile,
  readLatestSessionUsageFromTranscriptAsync as readLatestSessionUsageFromTranscriptAsyncFile,
  readRecentSessionMessages as readRecentSessionMessagesFile,
  readRecentSessionMessagesAsync as readRecentSessionMessagesAsyncFile,
  readRecentSessionMessagesWithStats as readRecentSessionMessagesWithStatsFile,
  readRecentSessionMessagesWithStatsAsync as readRecentSessionMessagesWithStatsAsyncFile,
  readRecentSessionTranscriptLines as readRecentSessionTranscriptLinesFile,
  readRecentSessionUsageFromTranscript as readRecentSessionUsageFromTranscriptFile,
  readRecentSessionUsageFromTranscriptAsync as readRecentSessionUsageFromTranscriptAsyncFile,
  readSessionMessageByIdAsync as readSessionMessageByIdAsyncFile,
  readSessionMessageCount as readSessionMessageCountFile,
  readSessionMessageCountAsync as readSessionMessageCountAsyncFile,
  readSessionMessages as readSessionMessagesFile,
  readSessionMessagesAsync as readSessionMessagesAsyncFile,
  readSessionMessagesWithSourceAsync as readSessionMessagesWithSourceAsyncFile,
  readSessionPreviewItemsFromTranscript as readSessionPreviewItemsFromTranscriptFile,
  readSessionTitleFieldsFromTranscript as readSessionTitleFieldsFromTranscriptFile,
  readSessionTitleFieldsFromTranscriptAsync as readSessionTitleFieldsFromTranscriptAsyncFile,
  visitSessionMessages as visitSessionMessagesFile,
  visitSessionMessagesAsync as visitSessionMessagesAsyncFile,
} from "./session-utils.fs.js";

export type { ReadRecentSessionMessagesOptions, ReadSessionMessagesAsyncOptions };
export { attachOpenClawTranscriptMeta, capArrayByJsonBytes } from "./session-utils.fs.js";

export type SessionTranscriptReadScope = {
  agentId?: string;
  sessionFile?: string;
  sessionId: string;
  storePath?: string;
};

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

type ReadRecentSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
  totalMessages: number;
};

type ReadSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
};

type ReadSessionMessageByIdResult = {
  message?: unknown;
  seq?: number;
  oversized: boolean;
  found: boolean;
};

type SessionTranscriptUsageSnapshot = {
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  costUsd?: number;
};

/** Reads display messages from a session transcript through the reader seam. */
export function readSessionMessages(scope: SessionTranscriptReadScope): unknown[] {
  return readSessionMessagesFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
  );
}

/** Reads recent display messages from a session transcript through the reader seam. */
export function readRecentSessionMessages(
  scope: SessionTranscriptReadScope,
  opts?: ReadRecentSessionMessagesOptions,
): unknown[] {
  return readRecentSessionMessagesFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
  );
}

/** Visits display messages from a session transcript through the reader seam. */
export function visitSessionMessages(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
): number {
  return visitSessionMessagesFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    visit,
    scope.agentId,
  );
}

/** Counts display messages in a session transcript through the reader seam. */
export function readSessionMessageCount(scope: SessionTranscriptReadScope): number {
  return readSessionMessageCountFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
  );
}

/** Reads display messages asynchronously through the reader seam. */
export async function readSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<unknown[]> {
  return await readSessionMessagesAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
  );
}

/** Reads display messages with source metadata through the reader seam. */
export async function readSessionMessagesWithSourceAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<ReadSessionMessagesResult> {
  return await readSessionMessagesWithSourceAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
  );
}

/** Reads recent display messages asynchronously through the reader seam. */
export async function readRecentSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts?: ReadRecentSessionMessagesOptions,
): Promise<unknown[]> {
  return await readRecentSessionMessagesAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
  );
}

/** Finds one display message by transcript id through the reader seam. */
export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  opts?: { allowResetArchiveFallback?: boolean },
): Promise<ReadSessionMessageByIdResult> {
  return await readSessionMessageByIdAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    messageId,
    { ...opts, agentId: scope.agentId },
  );
}

/** Visits display messages asynchronously through the reader seam. */
export async function visitSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
  opts: { mode: "full"; reason: string; cache?: "reuse" | "skip" },
): Promise<number> {
  return await visitSessionMessagesAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    visit,
    opts,
    scope.agentId,
  );
}

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  return await readSessionMessageCountAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
  );
}

/** Reads recent messages with total-count metadata through the reader seam. */
export function readRecentSessionMessagesWithStats(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions,
): ReadRecentSessionMessagesResult {
  return readRecentSessionMessagesWithStatsFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
  );
}

/** Reads recent messages with total-count metadata asynchronously through the reader seam. */
export async function readRecentSessionMessagesWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions,
): Promise<ReadRecentSessionMessagesResult> {
  return await readRecentSessionMessagesWithStatsAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
  );
}

/** Reads a bounded transcript tail for compaction and diagnostics through the reader seam. */
export function readRecentSessionTranscriptLines(
  params: SessionTranscriptReadScope & {
    maxLines: number;
  },
): { lines: string[]; totalLines: number } | null {
  return readRecentSessionTranscriptLinesFile({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    maxLines: params.maxLines,
  });
}

/** Reads title and preview text from a transcript through the reader seam. */
export function readSessionTitleFieldsFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  return readSessionTitleFieldsFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
    opts,
  );
}

/** Reads title and preview text asynchronously through the reader seam. */
export async function readSessionTitleFieldsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
  return await readSessionTitleFieldsFromTranscriptAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
    opts,
  );
}

/** Reads the first user message from a transcript through the reader seam. */
export function readFirstUserMessageFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): string | null {
  return readFirstUserMessageFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
    opts,
  );
}

/** Reads aggregate usage from a full transcript through the reader seam. */
export function readLatestSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
): SessionTranscriptUsageSnapshot | null {
  return readLatestSessionUsageFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
  );
}

/** Reads aggregate usage from a full transcript asynchronously through the reader seam. */
export async function readLatestSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
): Promise<SessionTranscriptUsageSnapshot | null> {
  return await readLatestSessionUsageFromTranscriptAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
  );
}

/** Reads aggregate usage from a bounded transcript tail through the reader seam. */
export async function readRecentSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
  return await readRecentSessionUsageFromTranscriptAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
    maxBytes,
  );
}

/** Reads latest usage from a bounded transcript tail through the reader seam. */
export async function readLatestRecentSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
  return await readLatestRecentSessionUsageFromTranscriptAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
    maxBytes,
  );
}

/** Reads aggregate usage from a bounded transcript tail synchronously through the reader seam. */
export function readRecentSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
  return readRecentSessionUsageFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
    maxBytes,
  );
}

/** Reads compact session preview items through the reader seam. */
export function readSessionPreviewItemsFromTranscript(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
): ReturnType<typeof readSessionPreviewItemsFromTranscriptFile> {
  return readSessionPreviewItemsFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
    maxItems,
    maxChars,
  );
}

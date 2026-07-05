<<<<<<< HEAD
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import { resolveSessionTranscriptReadTarget } from "../config/sessions/session-accessor.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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

<<<<<<< HEAD
export type { SessionTranscriptReadScope };
=======
export type SessionTranscriptReadScope = {
  agentId?: string;
  sessionFile?: string;
  sessionId: string;
  storePath?: string;
};
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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

<<<<<<< HEAD
type FileBackedReadScope = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  storePath?: string;
};

function resolveFileBackedReadScope(scope: SessionTranscriptReadScope): FileBackedReadScope {
  const target = resolveSessionTranscriptReadTarget(scope);
  const storePath = resolveConcreteReadStorePath(scope.storePath);
  return {
    agentId: target.agentId,
    sessionFile: target.sessionFile,
    sessionId: target.sessionId,
    ...(storePath ? { storePath } : {}),
  };
}

function resolveConcreteReadStorePath(storePath: string | undefined): string | undefined {
  const trimmed = storePath?.trim();
  if (!trimmed || trimmed === "(multiple)" || trimmed.includes("{agentId}")) {
    return undefined;
  }
  return trimmed;
}

/** Reads display messages from a session transcript through the reader seam. */
export function readSessionMessages(scope: SessionTranscriptReadScope): unknown[] {
  const target = resolveFileBackedReadScope(scope);
  return readSessionMessagesFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
/** Reads display messages from a session transcript through the reader seam. */
export function readSessionMessages(scope: SessionTranscriptReadScope): unknown[] {
  return readSessionMessagesFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads recent display messages from a session transcript through the reader seam. */
export function readRecentSessionMessages(
  scope: SessionTranscriptReadScope,
  opts?: ReadRecentSessionMessagesOptions,
): unknown[] {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return readRecentSessionMessagesFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
=======
  return readRecentSessionMessagesFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Visits display messages from a session transcript through the reader seam. */
export function visitSessionMessages(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
): number {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return visitSessionMessagesFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    visit,
    target.agentId,
=======
  return visitSessionMessagesFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    visit,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Counts display messages in a session transcript through the reader seam. */
export function readSessionMessageCount(scope: SessionTranscriptReadScope): number {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return readSessionMessageCountFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return readSessionMessageCountFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads display messages asynchronously through the reader seam. */
export async function readSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<unknown[]> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readSessionMessagesAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
=======
  return await readSessionMessagesAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads display messages with source metadata through the reader seam. */
export async function readSessionMessagesWithSourceAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<ReadSessionMessagesResult> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readSessionMessagesWithSourceAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
=======
  return await readSessionMessagesWithSourceAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads recent display messages asynchronously through the reader seam. */
export async function readRecentSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts?: ReadRecentSessionMessagesOptions,
): Promise<unknown[]> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readRecentSessionMessagesAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
=======
  return await readRecentSessionMessagesAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Finds one display message by transcript id through the reader seam. */
export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  opts?: { allowResetArchiveFallback?: boolean },
): Promise<ReadSessionMessageByIdResult> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readSessionMessageByIdAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    messageId,
    { ...opts, agentId: target.agentId },
=======
  return await readSessionMessageByIdAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    messageId,
    { ...opts, agentId: scope.agentId },
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Visits display messages asynchronously through the reader seam. */
export async function visitSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
  opts: { mode: "full"; reason: string; cache?: "reuse" | "skip" },
): Promise<number> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await visitSessionMessagesAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    visit,
    opts,
    target.agentId,
=======
  return await visitSessionMessagesAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    visit,
    opts,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readSessionMessageCountAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return await readSessionMessageCountAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads recent messages with total-count metadata through the reader seam. */
export function readRecentSessionMessagesWithStats(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions,
): ReadRecentSessionMessagesResult {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return readRecentSessionMessagesWithStatsFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
=======
  return readRecentSessionMessagesWithStatsFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads recent messages with total-count metadata asynchronously through the reader seam. */
export async function readRecentSessionMessagesWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions,
): Promise<ReadRecentSessionMessagesResult> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readRecentSessionMessagesWithStatsAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    opts,
    target.agentId,
=======
  return await readRecentSessionMessagesWithStatsAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    opts,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads a bounded transcript tail for compaction and diagnostics through the reader seam. */
export function readRecentSessionTranscriptLines(
  params: SessionTranscriptReadScope & {
    maxLines: number;
  },
): { lines: string[]; totalLines: number } | null {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(params);
  return readRecentSessionTranscriptLinesFile({
    sessionId: target.sessionId,
    storePath: target.storePath,
    sessionFile: target.sessionFile,
    agentId: target.agentId,
=======
  return readRecentSessionTranscriptLinesFile({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    maxLines: params.maxLines,
  });
}

/** Reads title and preview text from a transcript through the reader seam. */
export function readSessionTitleFieldsFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return readSessionTitleFieldsFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return readSessionTitleFieldsFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    opts,
  );
}

/** Reads title and preview text asynchronously through the reader seam. */
export async function readSessionTitleFieldsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readSessionTitleFieldsFromTranscriptAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return await readSessionTitleFieldsFromTranscriptAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    opts,
  );
}

/** Reads the first user message from a transcript through the reader seam. */
export function readFirstUserMessageFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): string | null {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return readFirstUserMessageFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return readFirstUserMessageFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    opts,
  );
}

/** Reads aggregate usage from a full transcript through the reader seam. */
export function readLatestSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
): SessionTranscriptUsageSnapshot | null {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return readLatestSessionUsageFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return readLatestSessionUsageFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads aggregate usage from a full transcript asynchronously through the reader seam. */
export async function readLatestSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
): Promise<SessionTranscriptUsageSnapshot | null> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readLatestSessionUsageFromTranscriptAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return await readLatestSessionUsageFromTranscriptAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

/** Reads aggregate usage from a bounded transcript tail through the reader seam. */
export async function readRecentSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readRecentSessionUsageFromTranscriptAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return await readRecentSessionUsageFromTranscriptAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    maxBytes,
  );
}

/** Reads latest usage from a bounded transcript tail through the reader seam. */
export async function readLatestRecentSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return await readLatestRecentSessionUsageFromTranscriptAsyncFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return await readLatestRecentSessionUsageFromTranscriptAsyncFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    maxBytes,
  );
}

/** Reads aggregate usage from a bounded transcript tail synchronously through the reader seam. */
export function readRecentSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return readRecentSessionUsageFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return readRecentSessionUsageFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    maxBytes,
  );
}

/** Reads compact session preview items through the reader seam. */
export function readSessionPreviewItemsFromTranscript(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
): ReturnType<typeof readSessionPreviewItemsFromTranscriptFile> {
<<<<<<< HEAD
  const target = resolveFileBackedReadScope(scope);
  return readSessionPreviewItemsFromTranscriptFile(
    target.sessionId,
    target.storePath,
    target.sessionFile,
    target.agentId,
=======
  return readSessionPreviewItemsFromTranscriptFile(
    scope.sessionId,
    scope.storePath,
    scope.sessionFile,
    scope.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    maxItems,
    maxChars,
  );
}

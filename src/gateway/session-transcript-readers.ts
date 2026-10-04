import { readSessionTranscriptBoundedMessageTailPageFromProjection } from "../config/sessions/session-accessor.sqlite-active-events-read.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptBoundedMessageTailOptions } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { bindSessionTranscriptStoreScope } from "../config/sessions/session-accessor.transcript-target.js";
import { readRestoredSessionTranscript } from "../config/sessions/session-cold-storage-read.js";
import { readSessionTranscriptAccountingFromProjection } from "../config/sessions/session-transcript-accounting.js";
import type { SessionTranscriptAccountingOptions } from "../config/sessions/session-transcript-accounting.types.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type {
  SessionArtifactReadQuery,
  SessionArtifactReadResult,
} from "./session-artifact-read.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import {
  resolveTranscriptReadTarget,
  toTranscriptReadScope,
} from "./session-transcript-read-target.js";
import type {
  SessionTranscriptSummaryQuery,
  SessionTranscriptSummaryResult,
} from "./session-transcript-summary.js";

export type { SessionTranscriptReadScope } from "./session-transcript-read.types.js";
export { capArrayByJsonBytes } from "./session-utils.fs.js";
export { attachOpenClawTranscriptMeta } from "./session-transcript-entry-message.js";
export { readSessionTranscriptVisibleMessageDeltaCore } from "../config/sessions/session-accessor.sqlite-active-events.js";

const sessionTranscriptReader = createSessionTranscriptReader({
  resolveTarget: resolveTranscriptReadTarget,
  readSnapshot: async (target, read, options) => {
    const scope = toTranscriptReadScope(target);
    return readRestoredSessionTranscript(
      scope,
      () => withCurrentProjectionSnapshot(scope, read, options),
      options,
    );
  },
});

function usesProcessHeldTranscript(scope: SessionTranscriptReadScope): boolean {
  // Incognito SQLite belongs to this process and cannot be reopened in a worker.
  return Boolean(
    isIncognitoSessionKey(scope.sessionKey) ||
    (scope.storePath &&
      isIncognitoOpenClawAgentSqlitePath(scope.storePath, {
        agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
        env: scope.env,
      })),
  );
}

function captureHistoryReadScope(scope: SessionTranscriptReadScope): SessionTranscriptReadScope {
  const target = bindSessionTranscriptStoreScope(scope);
  return {
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    ...(target.sessionFile ? { sessionFile: target.sessionFile } : {}),
    sessionEntry: target.sessionEntry ? { sessionId: target.sessionEntry.sessionId } : undefined,
    env: captureSessionTranscriptStorageEnvironment(target.env ?? process.env),
  };
}

export async function readSessionMessagesAsync(
  ...args: Parameters<typeof sessionTranscriptReader.readSessionMessagesAsync>
): Promise<unknown[]> {
  return (await readSessionMessagesWithSourceAsync(...args)).messages;
}

function createHistoryPageReader<Options, Result>(
  readLocal: (target: SessionTranscriptReadScope, options: Options) => Promise<Result>,
  readWorker: (
    read: typeof import("../config/sessions/session-history-worker-runtime.js").readSessionHistoryPageInWorker,
    target: SessionTranscriptReadScope,
    options: Options,
    signal?: AbortSignal,
  ) => Promise<Result>,
) {
  return async (
    scope: SessionTranscriptReadScope,
    inputOptions: Options,
    signal?: AbortSignal,
  ): Promise<Result> => {
    signal?.throwIfAborted();
    const target = captureHistoryReadScope(scope);
    const options = structuredClone(inputOptions);
    if (usesProcessHeldTranscript(target)) {
      const result = await readLocal(target, options);
      signal?.throwIfAborted();
      return result;
    }
    const { readSessionHistoryPageInWorker } =
      await import("../config/sessions/session-history-worker-runtime.js");
    signal?.throwIfAborted();
    const result = await readWorker(readSessionHistoryPageInWorker, target, options, signal);
    signal?.throwIfAborted();
    return result;
  };
}

export const readSessionMessagesWithSourceAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesWithSourceAsync,
  (read, target, options) => read({ kind: "source-messages", params: { target, options } }),
);

export const readSessionTranscriptAccountingAsync = createHistoryPageReader(
  async (target, options: SessionTranscriptAccountingOptions) =>
    withCurrentProjectionSnapshot(target, (projection) =>
      readSessionTranscriptAccountingFromProjection(projection, options),
    ),
  (read, target, options, signal) =>
    read({ kind: "active-accounting", params: { target, options } }, signal),
);

export const readSessionTranscriptBoundedMessageTailPageAsync = createHistoryPageReader(
  async (target, options: SessionTranscriptBoundedMessageTailOptions) =>
    withCurrentProjectionSnapshot(
      target,
      (projection) =>
        readSessionTranscriptBoundedMessageTailPageFromProjection(projection, options),
      options,
    ),
  (read, target, options) => read({ kind: "bounded-tail", params: { target, options } }),
);

export const readRecentSessionMessagesWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readRecentSessionMessagesWithStatsAsync,
  (read, target, options) => read({ kind: "recent-page", params: { target, options } }),
);

export const readSessionMessagesPageWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesPageWithStatsAsync,
  (read, target, options) => read({ kind: "message-page", params: { target, options } }),
);

export const readSessionMessagesAroundIdWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesAroundIdWithStatsAsync,
  (read, target, options) => read({ kind: "around-id", params: { target, options } }),
);

export function readSessionTranscriptSummaryAsync<Query extends SessionTranscriptSummaryQuery>(
  scope: SessionTranscriptReadScope,
  query: Query,
): Promise<Extract<SessionTranscriptSummaryResult, { kind: Query["kind"] }>>;
export async function readSessionTranscriptSummaryAsync(
  scope: SessionTranscriptReadScope,
  inputQuery: SessionTranscriptSummaryQuery,
): Promise<SessionTranscriptSummaryResult> {
  const target = captureHistoryReadScope(scope);
  const query = structuredClone(inputQuery);
  if (usesProcessHeldTranscript(target)) {
    return sessionTranscriptReader.readSessionTranscriptSummaryAsync(target, query);
  }
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({ kind: "summary", params: { target, query } });
}

export function readSessionArtifacts<Query extends SessionArtifactReadQuery>(
  scope: SessionTranscriptReadScope,
  query: Query,
): Promise<Extract<SessionArtifactReadResult, { kind: Query["kind"] }>>;
export async function readSessionArtifacts(
  scope: SessionTranscriptReadScope,
  inputQuery: SessionArtifactReadQuery,
): Promise<SessionArtifactReadResult> {
  const target = captureHistoryReadScope(scope);
  const query = structuredClone(inputQuery);
  if (usesProcessHeldTranscript(target)) {
    const { selectSessionArtifacts } = await import("./session-artifact-read.js");
    return selectSessionArtifacts(target, query, sessionTranscriptReader);
  }
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({ kind: "artifacts", params: { target, query } });
}

export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  options?: Parameters<typeof sessionTranscriptReader.readSessionMessageByIdAsync>[2],
) {
  const target = captureHistoryReadScope(scope);
  if (usesProcessHeldTranscript(target)) {
    return sessionTranscriptReader.readSessionMessageByIdAsync(target, messageId, options);
  }
  const capturedOptions = options ? structuredClone(options) : undefined;
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({
    kind: "message-by-id",
    params: { target, messageId, options: capturedOptions },
  });
}

export { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";

/** Keep exact membership and its full-history validation in the admitted history worker. */
export const readSessionMessagesMatchingIdAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesMatchingIdAsync,
  (read, target, messageId) => read({ kind: "message-lookup", params: { target, messageId } }),
);

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  const target = captureHistoryReadScope(scope);
  const inProcess = usesProcessHeldTranscript(target);
  const readCount = async () => {
    if (inProcess) {
      return sessionTranscriptReader.readSessionMessageCountAsync(target);
    }
    const { readSessionHistoryPageInWorker } =
      await import("../config/sessions/session-history-worker-runtime.js");
    return readSessionHistoryPageInWorker({ kind: "message-count", params: { target } });
  };
  try {
    return await readCount();
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // The failed read already scheduled the rebuild; wait before assigning
    // a sequence so a concurrent send cannot fail or reuse a stale count.
    await waitForSessionTranscriptProjection(target);
    return await readCount();
  }
}

export async function readSessionReactionsAsync(scope: SessionTranscriptReadScope) {
  const target = captureHistoryReadScope(scope);
  if (usesProcessHeldTranscript(target)) {
    const { listSessionReactions } = await import("../config/sessions/session-reaction-store.js");
    if (!target.sessionKey) {
      throw new Error("Reaction reads require a session key");
    }
    return listSessionReactions(
      { ...target, sessionKey: target.sessionKey },
      { sessionId: target.sessionId },
    );
  }
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({ kind: "reactions", params: { target } });
}

export async function readSessionConversationBindingAsync(
  scope: SessionTranscriptReadScope,
  conversationRef: string,
) {
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({
    kind: "conversation-binding",
    params: { target, conversationRef },
  });
}

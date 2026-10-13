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
import { captureIncognitoSessionHistoryBinding } from "../config/sessions/session-incognito-binding.js";
import {
  readIncognitoSessionHistory,
  type IncognitoSessionHistoryBinding,
} from "../config/sessions/session-incognito-history-read.js";
import { readSessionTranscriptAccountingFromProjection } from "../config/sessions/session-transcript-accounting.js";
import type { SessionTranscriptAccountingOptions } from "../config/sessions/session-transcript-accounting.types.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import type {
  SessionArtifactReadQuery,
  SessionArtifactReadResult,
} from "./session-artifact-read.js";
import {
  createIncognitoSessionHistoryReader,
  type IncognitoSessionHistoryReader,
} from "./session-history-snapshot.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import {
  resolveTranscriptReadTarget,
  toTranscriptReadScope,
} from "./session-transcript-read-target.js";
import type {
  ReadSessionMessagesAsyncOptions,
  SessionTranscriptReadOptions,
  SessionTranscriptReader,
} from "./session-transcript-read.types.js";
import { collectSessionTranscriptMessages } from "./session-transcript-source-pages.js";
import type {
  SessionTranscriptSummaryQuery,
  SessionTranscriptSummaryResult,
} from "./session-transcript-summary.js";

export type { SessionTranscriptReadScope } from "./session-transcript-read.types.js";
export { capArrayByJsonBytes } from "./session-utils.fs.js";
export { attachOpenClawTranscriptMeta } from "./session-transcript-entry-message.js";
export { readSessionTranscriptVisibleMessageDeltaCore } from "../config/sessions/session-accessor.sqlite-active-events.js";

/**
 * Production acquisition supplies no shared binding until the atomic P7 activation.
 * @internal P7 Knip production exception: remove when runtime acquisition installs the binding.
 */
export function captureIncognitoSessionHistoryReader(
  scope: SessionTranscriptReadScope,
  signal?: AbortSignal,
): IncognitoSessionHistoryReader | undefined {
  const binding = captureIncognitoSessionHistoryBinding(scope);
  return binding
    ? createIncognitoSessionHistoryReader({
        ...binding,
        target: {
          ...binding.target,
          agentId: binding.actor.agentId,
          storePath: binding.actor.path,
        },
        resolveCurrentUserProfileDisplay,
        signal,
      })
    : undefined;
}

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
  scope: SessionTranscriptReadScope,
  options: ReadSessionMessagesAsyncOptions & SessionTranscriptReadOptions,
  suppliedIncognito?: IncognitoSessionHistoryReader,
): Promise<unknown[]> {
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryReader(scope);
  if (incognito) {
    const captured = structuredClone(options);
    return incognito.consume(scope, (readers) =>
      captured.mode === "recent"
        ? readers
            .readRecentSessionMessagesWithStatsAsync(scope, captured)
            .then((result) => result.messages)
        : collectSessionTranscriptMessages(
            (target, pageOptions) =>
              readers.readSessionMessagesWithSourceAsync(target, pageOptions),
            scope,
            captured,
          ),
    );
  }
  if (options.mode === "recent") {
    return (await readRecentSessionMessagesWithStatsAsync(scope, options)).messages;
  }
  return collectSessionTranscriptMessages(readSessionMessagesWithSourceAsync, scope, options);
}

function createHistoryPageReader<Options, Result>(
  readLocal: (target: SessionTranscriptReadScope, options: Options) => Promise<Result>,
  readWorker: (
    read: typeof import("../config/sessions/session-history-worker-runtime.js").readSessionHistoryPageInWorker,
    target: SessionTranscriptReadScope,
    options: Options,
    signal?: AbortSignal,
  ) => Promise<Result>,
  readActor: (
    reader: SessionTranscriptReader,
    target: SessionTranscriptReadScope,
    options: Options,
    signal?: AbortSignal,
  ) => Promise<Result>,
) {
  return async (
    scope: SessionTranscriptReadScope,
    inputOptions: Options,
    signal?: AbortSignal,
    suppliedIncognito?: IncognitoSessionHistoryReader,
  ): Promise<Result> => {
    signal?.throwIfAborted();
    const options = structuredClone(inputOptions);
    const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryReader(scope, signal);
    if (incognito) {
      const result = await incognito.consume(scope, (readers) =>
        readActor(readers, scope, options, signal),
      );
      signal?.throwIfAborted();
      return result;
    }
    const target = captureHistoryReadScope(scope);
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
  (read, target, options, signal) =>
    read({ kind: "source-messages", params: { target, options } }, signal),
  (reader, scope, options) => reader.readSessionMessagesWithSourceAsync(scope, options),
);

const readSessionTranscriptAccounting = createHistoryPageReader(
  async (target, options: SessionTranscriptAccountingOptions) =>
    withCurrentProjectionSnapshot(target, (projection) =>
      readSessionTranscriptAccountingFromProjection(projection, options),
    ),
  (read, target, options, signal) =>
    read({ kind: "active-accounting", params: { target, options } }, signal),
  () => {
    throw new Error("Accounting requires its captured actor binding");
  },
);

export async function readSessionTranscriptAccountingAsync(
  scope: SessionTranscriptReadScope,
  options: SessionTranscriptAccountingOptions,
  signal?: AbortSignal,
  suppliedIncognito?: IncognitoSessionHistoryBinding,
) {
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    return readIncognitoSessionHistory(
      incognito,
      scope,
      (target) => ({ type: "session.history.accounting", input: { ...target, options } }),
      signal,
    );
  }
  return readSessionTranscriptAccounting(scope, options, signal);
}

const readSessionTranscriptBoundedMessageTailPage = createHistoryPageReader(
  async (target, options: SessionTranscriptBoundedMessageTailOptions) =>
    withCurrentProjectionSnapshot(
      target,
      (projection) =>
        readSessionTranscriptBoundedMessageTailPageFromProjection(projection, options),
      options,
    ),
  (read, target, options) => read({ kind: "bounded-tail", params: { target, options } }),
  () => {
    throw new Error("Bounded tail requires its captured actor binding");
  },
);

export async function readSessionTranscriptBoundedMessageTailPageAsync(
  scope: SessionTranscriptReadScope,
  options: SessionTranscriptBoundedMessageTailOptions,
  signal?: AbortSignal,
  suppliedIncognito?: IncognitoSessionHistoryBinding,
) {
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    return readIncognitoSessionHistory(
      incognito,
      scope,
      (target) => ({ type: "session.history.bounded-tail", input: { ...target, options } }),
      signal,
    );
  }
  return readSessionTranscriptBoundedMessageTailPage(scope, options, signal);
}

export const readRecentSessionMessagesWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readRecentSessionMessagesWithStatsAsync,
  (read, target, options) => read({ kind: "recent-page", params: { target, options } }),
  (reader, scope, options) => reader.readRecentSessionMessagesWithStatsAsync(scope, options),
);

export const readSessionMessagesPageWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesPageWithStatsAsync,
  (read, target, options, signal) =>
    read({ kind: "message-page", params: { target, options } }, signal),
  (reader, scope, options, signal) =>
    reader.readSessionMessagesPageWithStatsAsync(scope, options, signal),
);

export const readSessionMessagesAroundIdWithStatsAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesAroundIdWithStatsAsync,
  (read, target, options, signal) =>
    read({ kind: "around-id", params: { target, options } }, signal),
  (reader, scope, options, signal) =>
    reader.readSessionMessagesAroundIdWithStatsAsync(scope, options, signal),
);

export function readSessionTranscriptSummaryAsync<Query extends SessionTranscriptSummaryQuery>(
  scope: SessionTranscriptReadScope,
  query: Query,
  incognito?: IncognitoSessionHistoryReader,
): Promise<Extract<SessionTranscriptSummaryResult, { kind: Query["kind"] }>>;
export async function readSessionTranscriptSummaryAsync(
  scope: SessionTranscriptReadScope,
  inputQuery: SessionTranscriptSummaryQuery,
  suppliedIncognito?: IncognitoSessionHistoryReader,
): Promise<SessionTranscriptSummaryResult> {
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryReader(scope);
  if (incognito) {
    const query = structuredClone(inputQuery);
    return incognito.consume(scope, async () => {
      const { prepareSessionTranscriptSummaryReader } =
        await import("./session-transcript-summary.js");
      const select = await prepareSessionTranscriptSummaryReader(query);
      const messages: unknown[] = [];
      await incognito.visitSessionMessagesAsync(scope, (message) => messages.push(message));
      return select((visit) => messages.forEach(visit));
    });
  }
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
  incognito?: IncognitoSessionHistoryReader,
): Promise<Extract<SessionArtifactReadResult, { kind: Query["kind"] }>>;
export async function readSessionArtifacts(
  scope: SessionTranscriptReadScope,
  inputQuery: SessionArtifactReadQuery,
  suppliedIncognito?: IncognitoSessionHistoryReader,
): Promise<SessionArtifactReadResult> {
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryReader(scope);
  if (incognito) {
    const query = structuredClone(inputQuery);
    return incognito.consume(scope, async (readers) => {
      const { selectSessionArtifacts } = await import("./session-artifact-read.js");
      return selectSessionArtifacts(scope, query, {
        ...readers,
        visitSessionMessagesAsync: (target, visit) =>
          incognito.visitSessionMessagesAsync(target, visit),
      });
    });
  }
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
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const incognito = captureIncognitoSessionHistoryReader(scope, signal);
  if (incognito) {
    const captured = options ? structuredClone(options) : undefined;
    return incognito.consume(scope, (readers) =>
      readers.readSessionMessageByIdAsync(scope, messageId, captured, signal),
    );
  }
  const target = captureHistoryReadScope(scope);
  if (usesProcessHeldTranscript(target)) {
    return sessionTranscriptReader.readSessionMessageByIdAsync(target, messageId, options);
  }
  const capturedOptions = options ? structuredClone(options) : undefined;
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker(
    {
      kind: "message-by-id",
      params: { target, messageId, options: capturedOptions },
    },
    signal,
  );
}

export { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";

/** Keep exact membership and selected payload reads in the admitted history worker. */
export const readSessionMessagesMatchingIdAsync = createHistoryPageReader(
  sessionTranscriptReader.readSessionMessagesMatchingIdAsync,
  (read, target, messageId) => read({ kind: "message-lookup", params: { target, messageId } }),
  (reader, scope, messageId) => reader.readSessionMessagesMatchingIdAsync(scope, messageId),
);

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
  suppliedIncognito?: IncognitoSessionHistoryReader,
): Promise<number> {
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryReader(scope);
  if (incognito) {
    return incognito.consume(scope, (readers) => readers.readSessionMessageCountAsync(scope));
  }
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
  const incognito = captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    const { actor, authority, target } = incognito;
    const result = await actor.sessions.sideData(authority, {
      type: "session.reactions.read",
      input: target,
    });
    authority.assertCurrent();
    return result;
  }
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
  const incognito = captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    return readIncognitoSessionHistory(incognito, scope, (target) => ({
      type: "session.history.conversation-binding",
      input: { ...target, conversationRef },
    }));
  }
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({
    kind: "conversation-binding",
    params: { target, conversationRef },
  });
}

import {
  isSessionTranscriptProjectionUnavailableError,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.sqlite-active-events.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptBoundedMessageTailOptions } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { bindSessionTranscriptStoreScope } from "../config/sessions/session-accessor.transcript-target.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionActorTranscriptRead } from "../config/sessions/session-actor-transcript-read.js";
import type { SessionTranscriptAccountingOptions } from "../config/sessions/session-transcript-accounting.types.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type {
  SessionArtifactReadQuery,
  SessionArtifactReadResult,
} from "./session-artifact-read.js";
import { createSessionActorTranscriptReader } from "./session-transcript-memory-reader.js";
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
): Promise<unknown[]> {
  if (options.mode === "recent") {
    return (await readRecentSessionMessagesWithStatsAsync(scope, options)).messages;
  }
  return collectSessionTranscriptMessages(readSessionMessagesWithSourceAsync, scope, options);
}

function createHistoryPageReader<Options, Result>(
  readActor: (
    reader: SessionTranscriptReader,
    target: SessionTranscriptReadScope,
    options: Options,
    signal?: AbortSignal,
  ) => Promise<Result>,
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
    const options = structuredClone(inputOptions);
    const memory = captureSessionActorTranscriptRead(scope, signal);
    if (memory) {
      return readActor(createSessionActorTranscriptReader(memory), scope, options, signal);
    }
    const target = captureHistoryReadScope(scope);
    const { readSessionHistoryPageInWorker } =
      await import("../config/sessions/session-history-worker-runtime.js");
    signal?.throwIfAborted();
    const result = await readWorker(readSessionHistoryPageInWorker, target, options, signal);
    signal?.throwIfAborted();
    return result;
  };
}

export const readSessionMessagesWithSourceAsync = createHistoryPageReader(
  (
    reader,
    scope,
    options: Parameters<SessionTranscriptReader["readSessionMessagesWithSourceAsync"]>[1],
    signal,
  ) => reader.readSessionMessagesWithSourceAsync(scope, options, signal),
  (read, target, options, signal) =>
    read({ kind: "source-messages", params: { target, options } }, signal),
);

export async function readSessionTranscriptAccountingAsync(
  scope: SessionTranscriptReadScope,
  options: SessionTranscriptAccountingOptions,
  signal?: AbortSignal,
) {
  const captured = structuredClone(options);
  const memory = captureSessionActorTranscriptRead(scope, signal);
  if (memory) {
    return memory.read("session.history.accounting", { options: captured });
  }
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker(
    { kind: "active-accounting", params: { target, options: captured } },
    signal,
  );
}

export async function readSessionTranscriptBoundedMessageTailPageAsync(
  scope: SessionTranscriptReadScope,
  options: SessionTranscriptBoundedMessageTailOptions,
  signal?: AbortSignal,
) {
  const captured = structuredClone(options);
  const memory = captureSessionActorTranscriptRead(scope, signal);
  if (memory) {
    return memory.read("session.history.bounded-tail", { options: captured });
  }
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker(
    { kind: "bounded-tail", params: { target, options: captured } },
    signal,
  );
}

export const readRecentSessionMessagesWithStatsAsync = createHistoryPageReader(
  (
    reader,
    scope,
    options: Parameters<SessionTranscriptReader["readRecentSessionMessagesWithStatsAsync"]>[1],
  ) => reader.readRecentSessionMessagesWithStatsAsync(scope, options),
  (read, target, options) => read({ kind: "recent-page", params: { target, options } }),
);

export const readSessionMessagesPageWithStatsAsync = createHistoryPageReader(
  (
    reader,
    scope,
    options: Parameters<SessionTranscriptReader["readSessionMessagesPageWithStatsAsync"]>[1],
    signal,
  ) => reader.readSessionMessagesPageWithStatsAsync(scope, options, signal),
  (read, target, options, signal) =>
    read({ kind: "message-page", params: { target, options } }, signal),
);

export const readSessionMessagesAroundIdWithStatsAsync = createHistoryPageReader(
  (
    reader,
    scope,
    options: Parameters<SessionTranscriptReader["readSessionMessagesAroundIdWithStatsAsync"]>[1],
    signal,
  ) => reader.readSessionMessagesAroundIdWithStatsAsync(scope, options, signal),
  (read, target, options, signal) =>
    read({ kind: "around-id", params: { target, options } }, signal),
);

export function readSessionTranscriptSummaryAsync<Query extends SessionTranscriptSummaryQuery>(
  scope: SessionTranscriptReadScope,
  query: Query,
): Promise<Extract<SessionTranscriptSummaryResult, { kind: Query["kind"] }>>;
export async function readSessionTranscriptSummaryAsync(
  scope: SessionTranscriptReadScope,
  inputQuery: SessionTranscriptSummaryQuery,
): Promise<SessionTranscriptSummaryResult> {
  const query = structuredClone(inputQuery);
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    const { prepareSessionTranscriptSummaryReader } =
      await import("./session-transcript-summary.js");
    const select = await prepareSessionTranscriptSummaryReader(query);
    const messages: unknown[] = [];
    await createSessionActorTranscriptReader(memory).visitSessionMessagesAsync(scope, (message) =>
      messages.push(message),
    );
    return select((visit) => messages.forEach(visit));
  }
  const target = captureHistoryReadScope(scope);
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
  const query = structuredClone(inputQuery);
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    const { selectSessionArtifacts } = await import("./session-artifact-read.js");
    return selectSessionArtifacts(scope, query, createSessionActorTranscriptReader(memory));
  }
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({ kind: "artifacts", params: { target, query } });
}

export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  options?: Parameters<SessionTranscriptReader["readSessionMessageByIdAsync"]>[2],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const capturedOptions = options ? structuredClone(options) : undefined;
  const memory = captureSessionActorTranscriptRead(scope, signal);
  if (memory) {
    return createSessionActorTranscriptReader(memory).readSessionMessageByIdAsync(
      scope,
      messageId,
      capturedOptions,
      signal,
    );
  }
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker(
    { kind: "message-by-id", params: { target, messageId, options: capturedOptions } },
    signal,
  );
}

export { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";

/** Keep exact membership and selected payload reads in the owning history backend. */
export const readSessionMessagesMatchingIdAsync = createHistoryPageReader(
  (reader, scope, messageId: string) => reader.readSessionMessagesMatchingIdAsync(scope, messageId),
  (read, target, messageId) => read({ kind: "message-lookup", params: { target, messageId } }),
);

export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    return createSessionActorTranscriptReader(memory).readSessionMessageCountAsync(scope);
  }
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  const readCount = () =>
    readSessionHistoryPageInWorker({ kind: "message-count", params: { target } });
  try {
    return await readCount();
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // The failed read schedules the rebuild; wait before assigning a message sequence.
    await waitForSessionTranscriptProjection(target);
    return await readCount();
  }
}

export async function readSessionReactionsAsync(scope: SessionTranscriptReadScope) {
  const authority = { assertCurrent() {} };
  const memory = captureSessionActorStorageOwner(scope, authority);
  if (memory) {
    return (
      (await withSessionActorStorage(
        scope,
        {
          lifetime: {
            assertCurrent: memory.authority.assertCurrent,
            assertReadable: memory.authority.assertCurrent,
          },
          authority: memory.authority,
        },
        (binding) =>
          binding.actor.storage.read(
            { type: "session.reactions.read", input: { sessionId: scope.sessionId } },
            binding.authority,
          ),
      )) ?? {}
    );
  }
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({ kind: "reactions", params: { target } });
}

export async function readSessionConversationBindingAsync(
  scope: SessionTranscriptReadScope,
  conversationRef: string,
) {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    const { readConversation } = await import("../config/sessions/conversation-registry.js");
    const conversation = await readConversation(
      {
        agentId: memory.target.agentId,
        storePath: memory.target.storePath,
        env: memory.target.env,
      },
      conversationRef,
    );
    if (!conversation) {
      return null;
    }
    const { channel, accountId, target, threadId, nativeChannelId } = conversation;
    return { channel, accountId, target, threadId, nativeChannelId };
  }
  const target = captureHistoryReadScope(scope);
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({
    kind: "conversation-binding",
    params: { target, conversationRef },
  });
}

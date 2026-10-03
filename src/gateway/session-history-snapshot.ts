import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import type {
  ChatHistoryPageParams,
  PaginatedSessionHistory,
  SessionHistoryMessage,
  SessionHistoryReadParams,
  SessionHistorySnapshot,
} from "../config/sessions/session-history-types.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type {
  IncognitoHistoryOperations,
  IncognitoHistoryTarget,
} from "../config/sessions/session-incognito-history-contract.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import {
  projectChatDisplayMessagesWithState,
  type ChatDisplayProjectionOptions,
} from "./chat-display-projection.core.js";
import { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./chat-display-projection.helpers.js";
import type { SubagentCoordinationDisplayResolver } from "./chat-display-projection.history.js";
import type { CurrentUserProfileDisplayResolver } from "./current-user-profile-display.js";
import { getMaxChatHistoryMessagesBytes } from "./server-constants.js";
import {
  readChatHistoryMessageSeq as resolveMessageSeq,
  readIncrementalChatHistoryTail,
} from "./session-history-tail.js";
import type { SessionTranscriptReader } from "./session-transcript-read-kernel.js";

type SessionHistorySnapshotOptions = {
  readers: SessionTranscriptReader;
  readOnly?: boolean;
  deferProfileDisplay?: boolean;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: ChatDisplayProjectionOptions["resolveCronJobName"];
};

/** Keep raw scan context inside the worker; only the completed page crosses isolates. */
export async function readSessionHistorySnapshotKernel(
  params: SessionHistoryReadParams,
  options: SessionHistorySnapshotOptions,
): Promise<SessionHistorySnapshot> {
  let rawMessages: unknown[];
  let windowReset = false;
  let totalRawMessages: number | undefined;
  let transcriptPath: string | undefined;
  let projected: ReturnType<typeof projectChatDisplayMessagesWithState>;
  if (typeof params.limit !== "number") {
    const snapshot = await options.readers.readSessionMessagesWithSourceAsync(params.target, {
      mode: "full",
      reason: "session history cursor pagination",
      allowResetArchiveFallback: true,
      readOnly: options.readOnly,
    });
    rawMessages = snapshot.messages;
    transcriptPath = snapshot.transcriptPath;
    projected = projectChatDisplayMessagesWithState(rawMessages, {
      subagentCoordination: options.readers.subagentCoordination,
      includeCommentaryFallbacks: true,
      maxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
      resolveCronJobName: options.resolveCronJobName,
      ...(options.deferProfileDisplay
        ? {}
        : { resolveCurrentUserProfileDisplay: options.resolveCurrentUserProfileDisplay }),
    });
  } else {
    const cursorSeq = resolveCursorSeq(params.cursor);
    const tail = await readIncrementalChatHistoryTail({
      entry: params.target.sessionEntry,
      readScope: params.target,
      effectiveMaxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
      max: params.limit,
      maxBytes: getMaxChatHistoryMessagesBytes(),
      ...(cursorSeq === undefined ? {} : { beforeSeq: cursorSeq }),
      preserveProjectionContext: true,
      ...options,
    });
    windowReset = tail.windowReset ?? false;
    projected = tail.projection;
    rawMessages = tail.rawMessages;
    totalRawMessages = tail.readPage.totalMessages;
    transcriptPath = tail.readPage.transcriptPath;
  }
  const rawHistoryMessages = rawMessages.filter(isRecord);
  const history = paginateSessionMessages(
    projected.messages,
    params.limit,
    windowReset ? undefined : params.cursor,
  );
  if (
    typeof totalRawMessages === "number" &&
    totalRawMessages > rawMessages.length &&
    (!params.cursor || (resolveMessageSeq(rawHistoryMessages[0]) ?? 0) > 1)
  ) {
    const firstSeq = resolveMessageSeq(history.messages[0] ?? rawHistoryMessages[0]);
    history.hasMore = true;
    if (typeof firstSeq === "number") {
      history.nextCursor = String(firstSeq);
    }
  }
  return {
    history: { ...history, ...(windowReset ? { windowReset: true } : {}) },
    rawTranscriptSeq:
      totalRawMessages ?? resolveMessageSeq(rawHistoryMessages.at(-1)) ?? rawHistoryMessages.length,
    turnBoundaryPending: projected.turnBoundaryPending,
    assistantErrorPending: projected.assistantErrorPending,
    transcriptPath,
  };
}

export function resolveCursorSeq(cursor: string | undefined): number | undefined {
  if (!cursor) {
    return undefined;
  }
  const normalized = cursor.startsWith("seq:") ? cursor.slice(4) : cursor;
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function buildPaginatedSessionHistory(params: {
  messages: SessionHistoryMessage[];
  hasMore: boolean;
  nextCursor?: string;
}): PaginatedSessionHistory {
  return {
    items: params.messages,
    messages: params.messages,
    hasMore: params.hasMore,
    ...(params.nextCursor ? { nextCursor: params.nextCursor } : {}),
  };
}

function paginateSessionMessages(
  messages: SessionHistoryMessage[],
  limit: number | undefined,
  cursor: string | undefined,
): PaginatedSessionHistory {
  // Cursors point at transcript sequence watermarks. The returned page is the
  // window before that cursor, matching "older messages" pagination.
  const cursorSeq = resolveCursorSeq(cursor);
  let endExclusive = messages.length;
  if (typeof cursorSeq === "number") {
    endExclusive = messages.findIndex((message, index) => {
      const seq = resolveMessageSeq(message);
      if (typeof seq === "number") {
        return seq >= cursorSeq;
      }
      return index + 1 >= cursorSeq;
    });
    if (endExclusive < 0) {
      endExclusive = messages.length;
    }
  }
  let start = typeof limit === "number" && limit > 0 ? Math.max(0, endExclusive - limit) : 0;
  // Projection can interleave several rows from the same transcript records.
  // Close the page over their seq groups because the public cursor cannot split one.
  if (start > 0) {
    const pageSeqs = new Set<number>();
    let indexedStart = endExclusive;
    for (let index = start - 1; index >= 0; index--) {
      // Index only admitted intervals; unrelated older gaps need no retained sequence set.
      while (indexedStart > start) {
        const pageSeq = resolveMessageSeq(messages[--indexedStart]);
        if (pageSeq !== undefined) {
          pageSeqs.add(pageSeq);
        }
      }
      const seq = resolveMessageSeq(messages[index]);
      if (seq !== undefined && pageSeqs.has(seq)) {
        start = index;
      }
    }
  }
  const paginatedMessages = messages.slice(start, endExclusive);
  const firstSeq = resolveMessageSeq(paginatedMessages[0]);
  return buildPaginatedSessionHistory({
    messages: paginatedMessages,
    hasMore: start > 0,
    ...(start > 0 && typeof firstSeq === "number" ? { nextCursor: String(firstSeq) } : {}),
  });
}

/** Retain the actor across lazy adapter loading without expanding shared execution imports. */
export function createIncognitoSessionComputeReader(
  params: Parameters<
    typeof import("../config/sessions/session-incognito-compute-read.js").bindIncognitoSessionComputeReader
  >[0],
) {
  const { actor, authority, signal } = params;
  const target = structuredClone(params.target);
  signal?.throwIfAborted();
  return actor.sessions.withCompute(
    authority,
    target,
    async () => {
      const { bindIncognitoSessionComputeReader } =
        await import("../config/sessions/session-incognito-compute-read.js");
      signal?.throwIfAborted();
      return bindIncognitoSessionComputeReader({ actor, authority, target, signal });
    },
    signal,
  );
}

/** Inactive composition: callers retain the actor and supply already-prepared display facts. */
export function createIncognitoSessionHistoryReader(params: {
  actor: Pick<IncognitoAgentDatabaseExecution, "sessions" | "assertCurrent">;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget & { agentId: string; storePath: string };
  subagentCoordination: SubagentCoordinationDisplayResolver;
  resolveCurrentUserProfileDisplay: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: (jobId: string) => string | undefined;
  signal?: AbortSignal;
}) {
  const { actor, authority, signal, subagentCoordination } = params;
  authority.assertCurrent();
  actor.assertCurrent();
  const { agentId, storePath, ...target } = structuredClone(params.target);
  const capturedStorePath = path.resolve(storePath);
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    actor.assertCurrent();
    authority.assertCurrent();
    claim.assertCurrent();
    subagentCoordination.assertCurrent?.();
  };
  const assertScope = (scope: Partial<SessionTranscriptReadScope>) => {
    assertCurrent();
    if (
      scope.sessionId !== target.sessionId ||
      (scope.sessionKey !== undefined && scope.sessionKey !== target.sessionKey) ||
      (scope.agentId !== undefined && scope.agentId !== agentId) ||
      (scope.storePath !== undefined && path.resolve(scope.storePath) !== capturedStorePath) ||
      (scope.sessionEntry?.sessionId !== undefined &&
        scope.sessionEntry.sessionId !== target.sessionId)
    ) {
      throw new Error("Incognito history request belongs to another session or store");
    }
  };
  const disclose = <T>(value: T): T => {
    assertCurrent();
    claim.authorize(authority, "commit");
    assertCurrent();
    return value;
  };
  const read = async <Key extends keyof IncognitoHistoryOperations>(
    scope: SessionTranscriptReadScope,
    command: { type: Key; input: IncognitoHistoryOperations[Key]["input"] },
  ): Promise<IncognitoHistoryOperations[Key]["output"]> => {
    assertScope(scope);
    return disclose(await actor.sessions.history(authority, command, signal));
  };
  const readers: SessionTranscriptReader = {
    subagentCoordination,
    readSessionMessageCountAsync: (scope) =>
      read(scope, { type: "session.history.count", input: target }),
    readRecentSessionMessagesWithStatsAsync: (scope, options) =>
      read(scope, { type: "session.history.recent", input: { ...target, options } }),
    readSessionMessagesPageWithStatsAsync: (scope, options) =>
      read(scope, { type: "session.history.page", input: { ...target, options } }),
    readSessionMessagesAroundIdWithStatsAsync: (scope, options) =>
      read(scope, { type: "session.history.around-id", input: { ...target, options } }),
    readSessionMessageByIdAsync: async (scope, messageId, options) => {
      const { filterSessionMessageHistoryVisibility } =
        await import("./session-transcript-read-kernel.js");
      return disclose(
        await filterSessionMessageHistoryVisibility(
          await read(scope, {
            type: "session.history.by-id",
            input: { ...target, messageId, options },
          }),
          scope,
          messageId,
          options?.historyVisibility,
          readers,
        ),
      );
    },
    async readSessionMessagesWithSourceAsync(scope, options) {
      const { messages, offPathMessages, transcriptPath } = await read(scope, {
        type: "session.history.source",
        input: { ...target, options },
      });
      return disclose({
        messages: offPathMessages ? [...messages, ...offPathMessages] : messages,
        transcriptPath,
      });
    },
    async readSessionMessagesAsync(scope, options) {
      return disclose((await readers.readSessionMessagesWithSourceAsync(scope, options)).messages);
    },
    async readSessionMessagesMatchingIdAsync(scope, messageId) {
      return disclose(
        (
          await read(scope, {
            type: "session.history.lookup",
            input: { ...target, messageId },
          })
        ).messages,
      );
    },
  };
  const options = {
    readers,
    readOnly: true,
    resolveCurrentUserProfileDisplay: params.resolveCurrentUserProfileDisplay,
    resolveCronJobName: params.resolveCronJobName ?? (() => undefined),
  };
  return {
    readers,
    async rpc(request: ChatHistoryPageParams) {
      const captured = structuredClone(request);
      assertScope({
        agentId: captured.sessionAgentId,
        sessionId: captured.sessionId,
        sessionKey: captured.canonicalKey,
        storePath: captured.storePath,
        sessionEntry: captured.entry,
      });
      const [{ readChatHistoryPageKernel }, { encodeChatHistoryResponsePage }] = await Promise.all([
        import("./server-methods/chat-history-page-kernel.js"),
        import("./server-methods/chat-history-response-page.js"),
      ]);
      const page = await readChatHistoryPageKernel(captured, options);
      return disclose(encodeChatHistoryResponsePage(page, captured));
    },
    async http(request: SessionHistoryReadParams) {
      const captured = structuredClone(request);
      assertScope(captured.target);
      return disclose(await readSessionHistorySnapshotKernel(captured, options));
    },
  };
}

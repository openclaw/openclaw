import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import type {
  ChatHistoryPageParams,
  PaginatedSessionHistory,
  SessionHistoryMessage,
  SessionHistoryReadParams,
  SessionHistorySnapshot,
  SessionHistorySubagentFacts,
} from "../config/sessions/session-history-types.js";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type {
  IncognitoHistoryOperations,
  IncognitoHistoryTarget,
} from "../config/sessions/session-incognito-history-contract.js";
import { prepareIncognitoSessionHistoryRead } from "../config/sessions/session-incognito-history-read.js";
import type { PendingInputHistoryQuery } from "../config/sessions/session-pending-input-history.types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  projectChatDisplayMessagesWithState,
  createChatHistoryRecoveryProjection,
  type ChatDisplayProjectionOptions,
} from "./chat-display-projection.core.js";
import { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./chat-display-projection.helpers.js";
import type { CurrentUserProfileDisplayResolver } from "./current-user-profile-display.js";
import { getMaxChatHistoryMessagesBytes } from "./server-constants.js";
import {
  createPreparedSessionHistorySubagentProjection,
  prepareSessionHistorySubagentFacts,
} from "./session-history-delta-visibility.js";
import {
  buildPaginatedSessionHistory,
  readChatHistoryMessageSeq as resolveMessageSeq,
  readIncrementalChatHistoryTail,
  resolveCursorSeq,
} from "./session-history-tail.js";
import { projectTranscriptEntryMessage } from "./session-transcript-entry-message.js";
import type {
  SessionTranscriptReader,
  SubagentCoordinationDisplayResolver,
} from "./session-transcript-read.types.js";
import { iterateSessionTranscriptSourcePages } from "./session-transcript-source-pages.js";

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
    rawMessages = [];
    for await (const page of iterateSessionTranscriptSourcePages(
      options.readers.readSessionMessagesWithSourceAsync.bind(options.readers),
      params.target,
      {
        allowResetArchiveFallback: true,
        readOnly: options.readOnly,
      },
    )) {
      rawMessages.push(...page.messages);
      transcriptPath = page.transcriptPath;
    }
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

/** Retain actor history and prepare bounded visibility facts in its owning worker. */
export function createIncognitoSessionHistoryReader(params: {
  actor: IncognitoSessionActor;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget & { agentId: string; storePath: string };
  subagentCoordination?: SubagentCoordinationDisplayResolver;
  resolveCurrentUserProfileDisplay: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: (jobId: string) => string | undefined;
  signal?: AbortSignal;
}) {
  const { actor, authority, signal } = params;
  authority.assertCurrent();
  actor.assertCurrent();
  const { agentId, storePath, ...selected } = structuredClone(params.target);
  const prepared = prepareIncognitoSessionHistoryRead(
    { actor, authority, target: selected },
    {
      ...selected,
      agentId,
      storePath,
    },
    signal,
  );
  const target = prepared.target;
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    actor.assertCurrent();
    authority.assertCurrent();
    prepared.authority.assertCurrent();
    claim.assertCurrent();
    params.subagentCoordination?.assertCurrent?.();
    actor.assertReadable();
  };
  const assertScope = (scope: Partial<SessionTranscriptReadScope>) => {
    assertCurrent();
    if (
      scope.sessionId !== target.sessionId ||
      (scope.sessionKey !== undefined && scope.sessionKey !== target.sessionKey) ||
      (scope.agentId !== undefined && scope.agentId !== agentId) ||
      (scope.sessionEntry?.sessionId !== undefined &&
        scope.sessionEntry.sessionId !== target.sessionId)
    ) {
      throw new Error("Incognito history request belongs to another session or store");
    }
    prepareIncognitoSessionHistoryRead(prepared, { ...scope, sessionId: target.sessionId }, signal);
  };
  const disclose = <T>(value: T): T => {
    assertCurrent();
    claim.authorize(authority, "commit");
    assertCurrent();
    return value;
  };
  const visibilityEnv = { OPENCLAW_STATE_DIR: path.resolve(actor.path, "../../../..") };
  const consumption = new AsyncLocalStorage<{
    snapshot?: ReturnType<typeof actor.sessions.captureSnapshot>;
    facts?: SessionHistorySubagentFacts;
    subagents?: SubagentCoordinationDisplayResolver;
    visibilityChecks?: Array<() => void>;
    releaseVisibility?: Array<() => Promise<void>>;
    sharedVisibility?: Array<{ agentId: string; sessionKey: string; assertCurrent: () => void }>;
  }>();
  const currentSubagents = () => {
    const resolver = consumption.getStore()?.subagents;
    if (!resolver) {
      throw new Error("Incognito history visibility was not prepared");
    }
    return resolver;
  };
  const subagentCoordination: SubagentCoordinationDisplayResolver = params.subagentCoordination ?? {
    isSubagentSession: (key) => currentSubagents().isSubagentSession(key),
    isSubagentRunMessage: (runId, seq) => currentSubagents().isSubagentRunMessage(runId, seq),
  };
  const read = async <Key extends keyof IncognitoHistoryOperations>(
    scope: SessionTranscriptReadScope,
    command: { type: Key; input: IncognitoHistoryOperations[Key]["input"] },
    selectMessages?: (value: IncognitoHistoryOperations[Key]["output"]) => unknown[],
  ): Promise<IncognitoHistoryOperations[Key]["output"]> => {
    assertScope(scope);
    const current = consumption.getStore();
    const value = await actor.sessions.history(prepared.authority, command, signal, () => {
      if (current) {
        current.snapshot ??= actor.sessions.captureSnapshot(target.sessionKey);
        current.snapshot.assertCurrent();
      }
    });
    if (selectMessages) {
      await prepareVisibility(selectMessages(value));
    }
    return disclose(value);
  };
  const prepareVisibility = async (messages: unknown[]) => {
    if (params.subagentCoordination || messages.length === 0) {
      return subagentCoordination;
    }
    const current = consumption.getStore();
    if (!current) {
      throw new Error("Incognito history visibility requires its consuming lifetime");
    }
    const requested = prepareSessionHistorySubagentFacts(
      { isSubagentSession: () => false, isSubagentRunMessage: () => false },
      (recording) => {
        for (const message of messages) {
          createChatHistoryRecoveryProjection({ subagentCoordination: recording }).append([
            message,
          ]);
        }
      },
    );
    const lookups = [
      ...requested.sessions.map(([sessionKey]) => ({ kind: "session" as const, sessionKey })),
      ...requested.runMessages.map(([runId, messageSeq]) => ({
        kind: "run" as const,
        runId,
        messageSeq,
      })),
    ];
    if (lookups.length === 0) {
      current.subagents ??= createPreparedSessionHistorySubagentProjection(
        { sessions: [], runMessages: [] },
        assertCurrent,
      );
      return current.subagents;
    }
    const state = captureOpenClawStateWorkerContext({ env: visibilityEnv });
    // Worker readers also import this module; config belongs to this host-only preparation.
    const [{ getRuntimeConfig }, { prepareGatewaySessionStoreReadSourcesAsync }] =
      await Promise.all([
        import("../config/io.runtime.js"),
        import("./session-utils-store-sources.js"),
      ]);
    assertCurrent();
    state.maintenanceScope?.assertAdmission();
    state.admission.assertCurrent();
    const cfg = getRuntimeConfig();
    const sources = await prepareGatewaySessionStoreReadSourcesAsync({
      cfg,
      env: visibilityEnv,
      currentSource: { agentId, path: actor.path },
      registryPath: state.admission.databasePath,
    });
    const checks = (current.visibilityChecks ??= []);
    const checkSources = () => {
      state.maintenanceScope?.assertAdmission();
      state.admission.assertCurrent();
      sources.assertCurrent();
    };
    checks.push(checkSources);
    const incognitoSources = new Map<string, boolean>();
    for (;;) {
      checkSources();
      const result = await read(
        { ...target, agentId, storePath },
        {
          type: "session.history.visibility",
          input: {
            ...target,
            lookups,
            incognitoSources: [...incognitoSources],
            sourceDiscovery: sources.request,
            stateDatabase: { path: state.admission.databasePath, environment: state.environment },
          },
        },
      );
      if (result.missingSources.length === 0) {
        const facts = (current.facts ??= { sessions: [], runMessages: [] });
        facts.sessions.push(...result.facts.sessions);
        facts.runMessages.push(...result.facts.runMessages);
        current.subagents = createPreparedSessionHistorySubagentProjection(facts, () => {
          assertCurrent();
          current.snapshot?.assertCurrent();
          checks.forEach((check) => check());
          current.sharedVisibility?.forEach((source) => source.assertCurrent());
        });
        return current.subagents;
      }
      const [
        { captureOpenClawAgentDatabaseExecution },
        { resolveAgentIdFromSessionKey },
        { isSubagentSessionFromEntry },
      ] = await Promise.all([
        import("../state/openclaw-agent-execution.js"),
        import("../routing/session-key.js"),
        import("../agents/subagents/spawn/subagent-depth-policy.js"),
      ]);
      for (const sessionKey of result.missingSources) {
        const sourceAgentId = resolveAgentIdFromSessionKey(sessionKey);
        const source = captureOpenClawAgentDatabaseExecution
          .listIncognito(visibilityEnv)
          .find((item) => item.agentId === sourceAgentId);
        const entry = source?.facts.readSharing(sessionKey)?.entry;
        const sourceClaim = source?.facts.captureCurrent(sessionKey);
        const check = () => {
          sourceClaim?.assertCurrent();
          if (
            captureOpenClawAgentDatabaseExecution
              .listIncognito(visibilityEnv)
              .find((item) => item.agentId === sourceAgentId)?.identity.incarnation !==
              source?.identity.incarnation ||
            !isDeepStrictEqual(source?.facts.readSharing(sessionKey)?.entry, entry)
          ) {
            throw new Error("Incognito source lineage changed; prepare history again");
          }
        };
        checks.push(check);
        let hidden = isSubagentSessionFromEntry(sessionKey, entry);
        if (!hidden && entry && (entry.parentSessionKey || entry.spawnedBy) && source) {
          const sourceActor = await captureOpenClawAgentDatabaseExecution({
            kind: "ephemeral",
            agentId: sourceAgentId,
            env: visibilityEnv,
            authority: { assertCurrent: check },
            existingOnly: true,
            signal,
          });
          if (!sourceActor) {
            throw new Error("Incognito source actor ended while preparing history");
          }
          const releaseSource = sourceActor.release.bind(sourceActor);
          (current.releaseVisibility ??= []).push(releaseSource);
          const joined = await sourceActor.acp.prepareEntryRead({
            authority: { assertCurrent: check },
            cfg,
            env: visibilityEnv,
            databasePath: state.admission.databasePath,
            sessionKey,
          });
          current.releaseVisibility.push(async () => joined.release());
          (current.sharedVisibility ??= []).push({
            agentId: sourceAgentId,
            sessionKey,
            assertCurrent: joined.assertCurrent,
          });
          joined.assertCurrent();
          hidden = isSubagentSessionFromEntry(
            sessionKey,
            joined.session?.entry,
            joined.session?.acp,
          );
        }
        check();
        incognitoSources.set(sessionKey, hidden);
      }
    }
  };
  const readers: SessionTranscriptReader = {
    subagentCoordination,
    readSessionMessageCountAsync: (scope) =>
      read(scope, { type: "session.history.count", input: target }),
    readRecentSessionMessagesWithStatsAsync: (scope, options) =>
      read(
        scope,
        { type: "session.history.recent", input: { ...target, options } },
        (value) => value.messages,
      ),
    readSessionMessagesPageWithStatsAsync: (scope, options) =>
      read(
        scope,
        { type: "session.history.page", input: { ...target, options } },
        (value) => value.messages,
      ),
    readSessionMessagesAroundIdWithStatsAsync: (scope, options) =>
      read(
        scope,
        { type: "session.history.around-id", input: { ...target, options } },
        (value) => value.messages,
      ),
    readSessionMessageByIdAsync: async (scope, messageId, options) => {
      return consume(scope, async () => {
        const { filterSessionMessageHistoryVisibility } =
          await import("./session-transcript-read-kernel.js");
        return disclose(
          await filterSessionMessageHistoryVisibility(
            await read(
              scope,
              {
                type: "session.history.by-id",
                input: { ...target, messageId, options },
              },
              (value) => (value.message === undefined ? [] : [value.message]),
            ),
            scope,
            messageId,
            options?.historyVisibility,
            readers,
          ),
        );
      });
    },
    async readSessionMessagesWithSourceAsync(scope, options) {
      return read(
        scope,
        {
          type: "session.history.source",
          input: { ...target, options },
        },
        (value) => value.messages,
      );
    },
    async readSessionMessagesMatchingIdAsync(scope, messageId) {
      return disclose(
        (
          await read(
            scope,
            {
              type: "session.history.lookup",
              input: { ...target, messageId },
            },
            (value) => value.messages,
          )
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
  const pendingInputs = async () => {
    const { createIncognitoPendingInputHistoryReader } =
      await import("../config/sessions/session-pending-input-history.js");
    assertCurrent();
    return createIncognitoPendingInputHistoryReader({ actor, authority, target });
  };
  const consume = async <T>(
    scope: SessionTranscriptReadScope,
    operation: (readers: SessionTranscriptReader, assertReadCurrent: () => void) => Promise<T>,
  ): Promise<T> => {
    assertScope(scope);
    const outer = consumption.getStore();
    const current = outer ?? {};
    const assertReadCurrent = () => {
      current.snapshot?.assertCurrent();
      current.visibilityChecks?.forEach((check) => check());
      current.sharedVisibility?.forEach((source) => source.assertCurrent());
      disclose(undefined);
    };
    let outcome = await actor.sessions
      .withSharedState(() =>
        consumption.run(current, async () => {
          assertReadCurrent();
          const value = await operation(readers, assertReadCurrent);
          assertReadCurrent();
          return value;
        }),
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    if (outer) {
      if (!outcome.ok) {
        throw outcome.error;
      }
      assertReadCurrent();
      return outcome.value;
    }
    // Bridge the canonical ACP publication fence across asynchronous borrow cleanup.
    let sharedChanged = false;
    const stop = current.sharedVisibility?.length
      ? sessionChanges.subscribeFacts((change) => {
          if (
            "all" in change ||
            current.sharedVisibility?.some(
              (source) =>
                source.sessionKey === change.sessionKey &&
                (!change.agentId || source.agentId === change.agentId),
            )
          ) {
            sharedChanged = true;
          }
        })
      : undefined;
    try {
      if (outcome.ok) {
        try {
          assertReadCurrent();
        } catch (error) {
          outcome = { ok: false, error };
        }
      }
      const settled = await Promise.allSettled(
        current.releaseVisibility?.toReversed().map((release) => Promise.resolve().then(release)) ??
          [],
      );
      const errors = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (!outcome.ok) {
        if (errors.length) {
          throw new AggregateError(
            [outcome.error, ...errors],
            "Incognito history read and cleanup failed",
          );
        }
        throw outcome.error;
      }
      if (errors.length) {
        throw new AggregateError(errors, "Incognito history cleanup failed");
      }
      current.snapshot?.assertCurrent();
      current.visibilityChecks?.forEach((check) => check());
      if (sharedChanged) {
        throw new Error("Incognito history visibility changed during cleanup");
      }
      disclose(undefined);
      return outcome.value;
    } finally {
      stop?.();
    }
  };
  return {
    readers,
    consume,
    assertCurrent: () => {
      disclose(undefined);
    },
    visitSessionMessagesAsync(
      scope: SessionTranscriptReadScope,
      visit: (message: unknown, seq: number) => void,
    ) {
      return consume(scope, async (_readers, assertReadCurrent) => {
        let count = 0;
        let offset: number | undefined;
        do {
          const page = await read(scope, {
            type: "session.history.visitor-source",
            input: { ...target, offset },
          });
          for (const { message, seq } of page.messages) {
            assertReadCurrent();
            visit(message, seq);
            count++;
          }
          offset = page.nextOffset;
        } while (offset !== undefined);
        return count;
      });
    },
    delta<T>(
      scope: SessionTranscriptReadScope,
      limits: IncognitoHistoryOperations["session.history.delta"]["input"]["options"],
      project: (
        value: IncognitoHistoryOperations["session.history.delta"]["output"],
        subagents: SubagentCoordinationDisplayResolver,
      ) => Promise<T>,
    ) {
      const captured = structuredClone(limits);
      return consume(scope, async () => {
        const value = await read(scope, {
          type: "session.history.delta",
          input: { ...target, options: captured },
        });
        if (value.kind === "page") {
          await prepareVisibility(
            value.events.flatMap((row) =>
              row.messageSeq === undefined
                ? []
                : [projectTranscriptEntryMessage(row.event, row.messageSeq, row.displayPosition)],
            ),
          );
        }
        return project(value, subagentCoordination);
      });
    },
    listPendingInputs(query: Pick<PendingInputHistoryQuery, "limit" | "before"> = {}) {
      const captured = { ...query };
      assertCurrent();
      return actor.sessions
        .withSharedState(async () => (await pendingInputs()).list(captured))
        .then(disclose);
    },
    readPendingInput(id: string) {
      assertCurrent();
      return actor.sessions
        .withSharedState(async () => (await pendingInputs()).read(id))
        .then(disclose);
    },
    async rpc(request: ChatHistoryPageParams) {
      const captured = structuredClone(request);
      const scope = {
        agentId: captured.sessionAgentId,
        sessionId: captured.sessionId ?? "",
        sessionKey: captured.canonicalKey,
        storePath: captured.storePath,
        sessionEntry: captured.entry,
      };
      return consume(scope, async () => {
        const [{ readChatHistoryPageKernel }, { encodeChatHistoryResponsePage }] =
          await Promise.all([
            import("./server-methods/chat-history-page-kernel.js"),
            import("./server-methods/chat-history-response-page.js"),
          ]);
        const page = await readChatHistoryPageKernel(captured, options);
        return disclose(encodeChatHistoryResponsePage(page, captured));
      });
    },
    async http(request: SessionHistoryReadParams) {
      const captured = structuredClone(request);
      return consume(captured.target, () => readSessionHistorySnapshotKernel(captured, options));
    },
  };
}

export type IncognitoSessionHistoryReader = ReturnType<typeof createIncognitoSessionHistoryReader>;

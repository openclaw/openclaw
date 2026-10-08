import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type {
  SessionTranscriptWriteScope,
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  readSessionPendingInputWorkerReceipt,
  resolveSessionPendingInputAppend,
  runWithSessionPendingInputWorkerCustody,
  type SessionPendingInputWorkerFacts,
  type SessionPendingInputWorkerReceipt,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  findTranscriptEventInDatabase,
  readTranscriptIdentityByEventId,
  readTranscriptEventRows,
  readTranscriptSnapshot,
  type SqliteTranscriptSnapshotState,
} from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  transcriptWriteScopeIsCurrent,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import {
  readCommittedTranscriptMessageSequence,
  rememberCommittedTranscriptMessageSequencesInTransaction,
} from "./session-accessor.sqlite-transcript-sequences.js";
import {
  readTranscriptGenerationInTransaction,
  readTranscriptContextVersionInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  readTranscriptMessageByScopedIdempotencyKey,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  assertLockedTranscriptWriteAllowed,
  assertNonMessageTranscriptEvent,
} from "./session-accessor.sqlite-transcript-write-guard.js";
import type {
  LockedTranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";
import {
  assertSessionTranscriptHot,
  readSessionColdTranscript,
} from "./session-cold-storage-state.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import {
  compactManualTranscript,
  type ManualCompactInput,
} from "./session-manual-compact.worker.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import { readSessionPendingInputAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import { readRefusedSessionSource } from "./session-source-predicate.worker.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export type SessionMessageRewriteSelection = {
  scope: ResolvedTranscriptScope;
  target:
    | { kind: "anchor"; anchor: TranscriptEntryAnchor; active?: "exact" | "sequence" }
    | { kind: "terminal-assistant"; runId: string };
  expectedEntry?: {
    lifecycleRevision: string | null;
    activeWriterRunId?: string | null;
    owner?: SessionTranscriptWriteScope["expectedOwner"];
  };
};
export type SessionMessageRewriteSnapshot = {
  seq: number;
  eventJson: string;
  event: Record<string, unknown>;
};
export type SessionMessageRewriteCommitted = {
  kind: "session-message-rewrite";
  result: { generation: string; messageId: string; message: unknown } | null;
};

export type SessionMessageRewriteOperations = {
  "session.transcript.lock.cold": {
    input: { scope: ResolvedTranscriptScope };
    output: { archive: ReturnType<typeof readSessionColdTranscript> };
  };
  "session.transcript.lock.read": {
    input: { scope: ResolvedTranscriptScope };
    output: ReturnType<typeof readTranscriptSnapshot>;
  };
  "session.transcript.lock.prepare": {
    input: LockedTranscriptTarget & { options: LockedMessageOptions };
    output: ReturnType<typeof prepareLockedTranscriptAppend>;
  };
  "session.transcript.lock.facts": {
    input: LockedTranscriptTarget & { idempotencyKeys: readonly string[] };
    output: ReturnType<typeof readTranscriptMirrorFacts>;
  };
  "session.transcript.lock.commit": {
    input: LockedTranscriptMutation;
    output: ReturnType<typeof commitLockedTranscript>;
  };
  "session.transcript.manualCompact": {
    input: ManualCompactInput;
    output: ReturnType<typeof compactManualTranscript>;
  };
  "session.transcript.event.append": {
    input: { scope: ResolvedTranscriptScope; eventJson: string };
    output: ReturnType<typeof commitSessionTranscriptEvent>;
  };
  "session.transcript.correct": {
    input: {
      scope: ResolvedTranscriptScope;
      fence: SessionTranscriptWriteScope;
      version: SessionTranscriptContextVersion;
      allowLaterAppends: boolean;
      rows: Array<{ entryId: string; expectedEventJson: string; event: TranscriptEvent }>;
    };
    output: ReturnType<typeof commitSessionTranscriptCorrection>;
  };
  "session.messageRewrite.prepare": {
    input: SessionMessageRewriteSelection;
    output: SessionMessageRewriteSnapshot | null;
  };
  "session.messageRewrite.commit": {
    input: Parameters<typeof commitSessionMessageRewrite>[0];
    output: ReturnType<typeof commitSessionMessageRewrite>;
  };
};

/** Borrow the canonical executor connection without extending the released command union. */
export function bindSqliteWorkerBackend(
  input: { agentId: string },
  bound: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<SessionMessageRewriteOperations> {
  const options = {
    agentId: input.agentId,
    path: bound.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== bound.database || database.path !== bound.databasePath) {
    throw new Error("Transcript rewrite lost its canonical database owner");
  }
  const context: AgentWorkerOperationContext = {
    options,
    open: () => database,
    admit(stage, publication) {
      bound.admit(stage, (request, dispatch) => {
        if (!isRecord(request.facts)) {
          throw new Error("Transcript rewrite admission omitted its database identity");
        }
        dispatch({ ...request, facts: { ...request.facts, publication } });
      });
    },
    writeTransaction(operationLabel, owner, write) {
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== bound.database) {
            throw new Error(`${owner} lost its canonical database owner`);
          }
          context.admit("transaction");
          return write(current);
        },
        options,
        { operationLabel },
      );
    },
  };
  return {
    execute(command) {
      switch (command.type) {
        case "session.transcript.lock.cold":
          return { archive: readSessionColdTranscript(database.db, command.input.scope.sessionId) };
        case "session.transcript.lock.read":
          return readTranscriptSnapshot(database, command.input.scope.sessionId);
        case "session.transcript.lock.prepare":
          return withLockedCustody(command.input, context, () =>
            prepareLockedTranscriptAppend(command.input, database),
          );
        case "session.transcript.lock.facts":
          return readTranscriptMirrorFacts(database, command.input.scope, command.input);
        case "session.transcript.lock.commit":
          return commitLockedTranscript(command.input, context);
        case "session.transcript.manualCompact":
          return compactManualTranscript(command.input, context);
        case "session.transcript.event.append":
          return commitSessionTranscriptEvent(command.input, context);
        case "session.transcript.correct":
          return commitSessionTranscriptCorrection(command.input, context);
        case "session.messageRewrite.prepare":
          return prepareSessionMessageRewrite(command.input, context);
        case "session.messageRewrite.commit":
          return commitSessionMessageRewrite(command.input, context);
      }
      throw new Error("Unknown transcript rewrite domain operation");
    },
    assertSettled() {
      assertTransactionUsable(bound.database);
      if (bound.database.isTransaction) {
        throw new Error("Transcript rewrite transaction did not settle");
      }
    },
    close() {},
  };
}

type LockedTranscriptTarget = {
  scope: ResolvedTranscriptScope;
  fence: SessionTranscriptWriteScope;
  custody?: SessionPendingInputWorkerFacts;
  relocation?: string;
};
type LockedMessageOptions = Omit<
  LockedTranscriptMessageAppendOptions<unknown>,
  | "config"
  | "message"
  | "beforeFreshMessageCommit"
  | "prepareMessageAfterIdempotencyCheck"
  | "prepareMessageAfterIdempotencyCheckAsync"
> & {
  message: { role?: "user"; idempotencyKey?: string } | null | undefined;
};
export type LockedTranscriptCommitted = {
  kind: "session-transcript-locked";
  result?: TranscriptMessageAppendResult<unknown>;
  messageSeq?: number;
  lifecycleRevision?: string;
  custody?: SessionPendingInputWorkerReceipt;
  authority?: SessionPendingInputAuthorityFacts;
  projectionNeedsReconcile: boolean;
  snapshot?: SqliteTranscriptSnapshotState;
};
type LockedTranscriptMutation = LockedTranscriptTarget & {
  sources: SessionSourcePredicate[];
  snapshot?: SqliteTranscriptSnapshotState;
} & (
    | { kind: "replace"; events: readonly TranscriptEvent[] }
    | {
        kind: "message";
        options: LockedMessageOptions;
        freshSources: SessionSourcePredicate[];
        freshAuthorityPrepared: boolean;
        sequenced: boolean;
        preparedMessageJson: string | undefined;
        preparation?: {
          prepared: boolean;
          version: SessionTranscriptContextVersion;
        };
      }
  );

function withLockedCustody<T>(
  input: LockedTranscriptTarget,
  context: AgentWorkerOperationContext,
  run: () => T,
): T {
  return input.custody
    ? runWithSessionPendingInputWorkerCustody(
        input.custody,
        input.relocation,
        () =>
          context.admit("transaction", {
            kind: "session-transcript-lock-custody",
            authority: input.custody!.preparedAuthority
              ? readSessionPendingInputAuthorityFacts(
                  context.open(),
                  input.custody!.sessionKey,
                  input.custody!.agentId,
                )
              : undefined,
          }),
        run,
      ).value
    : run();
}

function prepareLockedTranscriptAppend(
  input: LockedTranscriptTarget & { options: LockedMessageOptions },
  database: OpenClawAgentDatabase,
) {
  assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
  const key = readMessageIdempotencyKey(input.options.message);
  return {
    version: readTranscriptContextVersionInTransaction(database, input.scope.sessionId),
    pending: Boolean(
      resolveSessionPendingInputAppend(database, input.scope, input.options.message),
    ),
    existing:
      key && input.options.idempotencyLookup !== "caller-checked"
        ? readTranscriptMessageByScopedIdempotencyKey(
            database,
            input.scope,
            key,
            input.options.idempotencyLookup,
          )
        : undefined,
  };
}

function commitLockedTranscript(
  input: LockedTranscriptMutation,
  context: AgentWorkerOperationContext,
) {
  return withLockedCustody(input, context, () =>
    context.writeTransaction("session.transcript.locked-write", "Locked transcript", (database) => {
      const assertSources = (fresh: boolean, sources: SessionSourcePredicate[]) =>
        context.admit("transaction", {
          kind: "session-transcript-lock-source",
          fresh,
          refusedSource: readRefusedSessionSource(database, sources),
        });
      assertSources(false, input.sources);
      const entry = assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
      let projectionNeedsReconcile = false;
      const projection = {
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded: () => {
          projectionNeedsReconcile = true;
        },
      };
      const snapshotCurrent =
        input.snapshot?.kind === "current" &&
        isDeepStrictEqual(
          input.snapshot.rows,
          readTranscriptEventRows(database, input.scope.sessionId),
        );
      let result: TranscriptMessageAppendResult<unknown> | undefined;
      let messageSeq: number | undefined;
      if (input.kind === "message") {
        const preparation = input.preparation;
        const preparedMessage =
          input.preparedMessageJson === undefined
            ? undefined
            : {
                messageJson: input.preparedMessageJson,
                persistedMessage: JSON.parse(input.preparedMessageJson),
              };
        result = appendTranscriptMessageInTransaction(
          database,
          input.scope,
          {
            ...input.options,
            ...(preparation
              ? {
                  prepareMessageAfterIdempotencyCheck: () => {
                    const current = readTranscriptContextVersionInTransaction(
                      database,
                      input.scope.sessionId,
                    );
                    if (
                      !preparation.prepared ||
                      current.generation !== preparation.version.generation ||
                      current.rawSeq !== preparation.version.rawSeq ||
                      current.updatedAt !== preparation.version.updatedAt
                    ) {
                      throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
                    }
                    return preparedMessage?.persistedMessage;
                  },
                }
              : {}),
            beforeFreshMessageCommit: () => {
              if (!input.freshAuthorityPrepared) {
                throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
              }
              assertSources(true, input.freshSources);
            },
          },
          preparedMessage,
          projection,
        )?.result;
        if (result && input.sequenced) {
          rememberCommittedTranscriptMessageSequencesInTransaction(
            database,
            input.scope.sessionId,
            [result],
          );
          messageSeq = readCommittedTranscriptMessageSequence(result);
        }
      } else {
        if (input.snapshot && !snapshotCurrent) {
          throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
        }
        replaceSqliteTranscriptEventsInTransaction(database, input.scope, input.events, projection);
      }
      assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
      const candidate: LockedTranscriptCommitted = {
        kind: "session-transcript-locked",
        result,
        messageSeq,
        lifecycleRevision: entry?.lifecycleRevision,
        custody: readSessionPendingInputWorkerReceipt(database),
        authority: input.custody?.preparedAuthority
          ? readSessionPendingInputAuthorityFacts(
              database,
              input.custody.sessionKey,
              input.custody.agentId,
            )
          : undefined,
        projectionNeedsReconcile,
        snapshot:
          input.snapshot || input.kind === "replace"
            ? input.kind === "replace" || snapshotCurrent
              ? { kind: "current", rows: readTranscriptEventRows(database, input.scope.sessionId) }
              : { kind: "stale" }
            : undefined,
      };
      return transferSessionEntryWorkerCandidate(database, context.admit, candidate);
    }),
  );
}

export type SessionTranscriptEventCommitted = {
  kind: "session-transcript-event";
  projectionNeedsReconcile: boolean;
};

function commitSessionTranscriptEvent(
  input: SessionMessageRewriteOperations["session.transcript.event.append"]["input"],
  { writeTransaction, admit }: AgentWorkerOperationContext,
) {
  const event: TranscriptEvent = JSON.parse(input.eventJson);
  assertNonMessageTranscriptEvent(event);
  return writeTransaction("session.transcript.event-append", "Transcript event", (database) => {
    assertSessionTranscriptHot(database.db, input.scope.sessionId);
    const entry = readSessionEntryRow(database, input.scope.sessionKey, "list");
    if (entry?.entry.sessionId !== input.scope.sessionId) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    const candidate: SessionTranscriptEventCommitted = {
      kind: "session-transcript-event",
      projectionNeedsReconcile: false,
    };
    appendTranscriptEventInTransaction(database, input.scope, event, {
      eventJson: input.eventJson,
      scheduleProjectionReconcile: false,
      onProjectionReconcileNeeded: () => {
        candidate.projectionNeedsReconcile = true;
      },
    });
    return transferSessionEntryWorkerCandidate(database, admit, candidate);
  });
}

export type SessionTranscriptCorrectionCommitted = {
  kind: "session-transcript-correction";
  generation: string | null;
};

function commitSessionTranscriptCorrection(
  input: SessionMessageRewriteOperations["session.transcript.correct"]["input"],
  { writeTransaction, admit }: AgentWorkerOperationContext,
) {
  return writeTransaction(
    "session.transcript.rewrite-exact",
    "Transcript correction",
    (database) => {
      assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
      const current = readTranscriptContextVersionInTransaction(database, input.scope.sessionId);
      const candidate: SessionTranscriptCorrectionCommitted = {
        kind: "session-transcript-correction",
        generation: null,
      };
      if (
        current.generation !== input.version.generation ||
        (!input.allowLaterAppends &&
          (current.rawSeq !== input.version.rawSeq ||
            current.updatedAt !== input.version.updatedAt))
      ) {
        if (input.allowLaterAppends) {
          return transferSessionEntryWorkerCandidate(database, admit, candidate);
        }
        throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
      }
      const rows = input.rows.map((row) => {
        const identity = readTranscriptIdentityByEventId(
          database,
          input.scope.sessionId,
          row.entryId,
        );
        if (!identity) {
          throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
        }
        return { ...row, seq: identity.seq };
      });
      rewriteSqliteTranscriptEventRowsInTransaction(database, input.scope, rows);
      assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
      candidate.generation =
        readTranscriptGenerationInTransaction(database, input.scope.sessionId) ?? null;
      return transferSessionEntryWorkerCandidate(database, admit, candidate);
    },
  );
}

export function prepareSessionMessageRewrite(
  input: SessionMessageRewriteSelection,
  { open }: Pick<AgentWorkerOperationContext, "open">,
): SessionMessageRewriteSnapshot | null {
  const database = open();
  const { scope, target, expectedEntry } = input;
  assertSessionTranscriptHot(database.db, scope.sessionId);
  if (expectedEntry) {
    const current = readSessionEntryRow(database, scope.sessionKey)?.entry;
    if (
      !transcriptWriteScopeIsCurrent(current, scope.sessionId, {
        sessionKey: scope.sessionKey,
        expectedOwner: expectedEntry.owner,
      }) ||
      current?.lifecycleRevision !== (expectedEntry.lifecycleRevision ?? undefined) ||
      (expectedEntry.activeWriterRunId !== undefined &&
        current?.activeWriterRunId !== (expectedEntry.activeWriterRunId ?? undefined))
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  }
  let seq: number;
  if (target.kind === "anchor") {
    seq = target.anchor.rawSeq;
    if (target.active) {
      const active = readActiveTranscriptEntryAnchorInTransaction({
        database,
        resolved: scope,
        entryId: target.anchor.entryId,
      });
      if (
        target.active === "exact"
          ? !isDeepStrictEqual(active, target.anchor)
          : active?.rawSeq !== seq
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    }
  } else {
    const found = findTranscriptEventInDatabase(
      database,
      scope.sessionId,
      (event) =>
        isRecord(event) &&
        isRecord(event.message) &&
        readSessionTranscriptRunId(event.message) === target.runId &&
        resolveTerminalAssistantTranscriptRunId(event.message, target.runId) !== undefined,
    );
    const event = found?.event;
    if (!isRecord(event) || typeof event.id !== "string") {
      return null;
    }
    const identity = readTranscriptIdentityByEventId(database, scope.sessionId, event.id);
    if (!identity) {
      return null;
    }
    seq = identity.seq;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(transcriptEventJsonSql(database.db).as("event_json"))
      .where("session_id", "=", scope.sessionId)
      .where("seq", "=", seq),
  );
  if (!row) {
    return null;
  }
  const event: unknown = JSON.parse(row.event_json);
  if (
    !isRecord(event) ||
    event.type !== "message" ||
    typeof event.id !== "string" ||
    (target.kind === "anchor" && event.id !== target.anchor.entryId)
  ) {
    return null;
  }
  return { seq, eventJson: row.event_json, event };
}

export function commitSessionMessageRewrite(
  input: SessionMessageRewriteSelection & {
    expected: SessionMessageRewriteSnapshot;
    message: unknown;
  },
  { writeTransaction, admit }: AgentWorkerOperationContext,
) {
  return writeTransaction(
    "session.transcript.message-rewrite",
    "Transcript rewrite",
    (database: OpenClawAgentDatabase) => {
      const current = prepareSessionMessageRewrite(input, { open: () => database });
      if (
        !current ||
        current.seq !== input.expected.seq ||
        current.eventJson !== input.expected.eventJson
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      const changed = input.message !== undefined;
      if (changed) {
        rewriteSqliteTranscriptEventRowsInTransaction(database, input.scope, [
          {
            event: { ...current.event, message: input.message },
            expectedEventJson: current.eventJson,
            seq: current.seq,
          },
        ]);
      }
      const generation = readTranscriptGenerationInTransaction(database, input.scope.sessionId);
      const candidate: SessionMessageRewriteCommitted = {
        kind: "session-message-rewrite",
        result:
          generation && (changed || input.target.kind === "terminal-assistant")
            ? {
                generation,
                messageId: String(current.event.id),
                message: changed ? input.message : current.event.message,
              }
            : null,
      };
      return transferSessionEntryWorkerCandidate(database, admit, candidate);
    },
  );
}

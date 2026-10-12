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
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
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
import {
  createSessionWorkerOperationContext,
  transferSessionEntryWorkerCandidate,
} from "./session-entry-patch.worker.js";
import {
  compactManualTranscript,
  type ManualCompactInput,
} from "./session-manual-compact.worker.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import { readSessionPendingInputAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import type {
  SessionMessageRewriteSelection,
  SessionMessageRewriteSnapshot,
  SessionMessageRewriteCommitted,
  SessionTranscriptEventCommitted,
  SessionTranscriptCorrectionCommitted,
  SessionTranscriptCorrectionInput,
} from "./session-transcript-mutation.types.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

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
    input: LockedTranscriptTarget & { idempotencyKeys: readonly string[]; sourceRunId?: string };
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
    input: {
      scope: ResolvedTranscriptScope;
      eventJson: string;
      fence?: SessionTranscriptWriteScope;
    };
    output: ReturnType<typeof commitSessionTranscriptEvent>;
  };
  "session.transcript.correct": {
    input: SessionTranscriptCorrectionInput;
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
  const context = createSessionWorkerOperationContext(
    database,
    options,
    bound,
    "Transcript rewrite",
  );
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
  | "preparation"
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
          sourceValidation: readSessionSourceValidation(database, sources),
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

export function commitSessionTranscriptEvent(
  input: SessionMessageRewriteOperations["session.transcript.event.append"]["input"],
  context: AgentWorkerOperationContext,
) {
  return applySessionTranscriptEvent(input, context, (database, candidate) =>
    transferSessionEntryWorkerCandidate(database, context.admit, candidate),
  );
}

export function applySessionTranscriptEvent<T>(
  input: SessionMessageRewriteOperations["session.transcript.event.append"]["input"],
  { writeTransaction }: AgentWorkerOperationContext,
  publish: (database: OpenClawAgentDatabase, candidate: SessionTranscriptEventCommitted) => T,
) {
  const event: TranscriptEvent = JSON.parse(input.eventJson);
  assertNonMessageTranscriptEvent(event);
  return writeTransaction("session.transcript.event-append", "Transcript event", (database) => {
    assertSessionTranscriptHot(database.db, input.scope.sessionId);
    if (input.fence) {
      assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
    }
    const entry = readSessionEntryRow(database, input.scope.sessionKey, "list");
    if (entry?.entry.sessionId !== input.scope.sessionId) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    const candidate: SessionTranscriptEventCommitted = {
      kind: "session-transcript-event",
      appended: false,
      projectionNeedsReconcile: false,
    };
    candidate.appended =
      appendTranscriptEventInTransaction(database, input.scope, event, {
        eventJson: input.eventJson,
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded: () => {
          candidate.projectionNeedsReconcile = true;
        },
      }) !== false;
    if (input.fence) {
      assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
    }
    return publish(database, candidate);
  });
}

function commitSessionTranscriptCorrection(
  input: SessionMessageRewriteOperations["session.transcript.correct"]["input"],
  { writeTransaction, admit }: AgentWorkerOperationContext,
) {
  return writeTransaction(
    "session.transcript.rewrite-exact",
    "Transcript correction",
    (database) => {
      return transferSessionEntryWorkerCandidate(
        database,
        admit,
        applySessionTranscriptCorrection(database, input),
      );
    },
  );
}

export function applySessionTranscriptCorrection(
  database: OpenClawAgentDatabase,
  input: SessionMessageRewriteOperations["session.transcript.correct"]["input"],
): SessionTranscriptCorrectionCommitted {
  assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
  const current = readTranscriptContextVersionInTransaction(database, input.scope.sessionId);
  const candidate: SessionTranscriptCorrectionCommitted = {
    kind: "session-transcript-correction",
    generation: null,
  };
  if (
    current.generation !== input.version.generation ||
    (!input.allowLaterAppends &&
      (current.rawSeq !== input.version.rawSeq || current.updatedAt !== input.version.updatedAt))
  ) {
    if (input.allowLaterAppends) {
      return candidate;
    }
    throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
  }
  const rows = input.rows.map((row) => {
    const identity = readTranscriptIdentityByEventId(database, input.scope.sessionId, row.entryId);
    if (!identity) {
      throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
    }
    return { ...row, seq: identity.seq };
  });
  const generation = rewriteSqliteTranscriptEventRowsInTransaction(database, input.scope, rows);
  assertLockedTranscriptWriteAllowed(database, input.scope, input.fence);
  candidate.generation = generation ?? current.generation;
  return candidate;
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
  context: AgentWorkerOperationContext,
) {
  return applySessionMessageRewrite(input, context, (database, candidate) =>
    transferSessionEntryWorkerCandidate(database, context.admit, candidate),
  );
}

export function applySessionMessageRewrite<T>(
  input: SessionMessageRewriteSelection & {
    expected: SessionMessageRewriteSnapshot;
    message: unknown;
  },
  { writeTransaction }: AgentWorkerOperationContext,
  publish: (database: OpenClawAgentDatabase, candidate: SessionMessageRewriteCommitted) => T,
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
      let generation: string | undefined;
      if (changed) {
        generation = rewriteSqliteTranscriptEventRowsInTransaction(database, input.scope, [
          {
            event: { ...current.event, message: input.message },
            expectedEventJson: current.eventJson,
            seq: current.seq,
          },
        ]);
      }
      generation ??= readTranscriptGenerationInTransaction(database, input.scope.sessionId);
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
      return publish(database, candidate);
    },
  );
}

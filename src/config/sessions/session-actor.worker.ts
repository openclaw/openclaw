import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import {
  readSqliteDatabasePendingScopedWriteToken,
  readSqliteDatabaseScopedWriteToken,
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerTransferOwner } from "../../infra/sqlite-worker-transfer.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import { captureSessionEntrySnapshot } from "./session-accessor.sqlite-entry-snapshot.js";
import { projectSessionActorAuthority } from "./session-actor-command.js";
import { rewriteSessionActorContextMetadata } from "./session-actor-context-metadata.js";
import type {
  SessionActorOperations,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { observeSessionActorCommand } from "./session-actor-diagnostics.js";
import {
  registerSessionActorEntryPatchOwner,
  registerSessionActorParticipantOwner,
} from "./session-actor-entry-publication.worker.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import {
  hydrateSessionActorState,
  projectSessionActorHotState,
} from "./session-actor-hydration.worker.js";
import { replaceSessionActorParticipants } from "./session-actor-participants.js";
import {
  applySessionActorPhase,
  SessionActorStaleStateError,
} from "./session-actor-phase.worker.js";
import { createSessionActorCommittedOutcome } from "./session-actor-receipt.js";
import { createSessionActorResidency } from "./session-actor-residency.worker.js";
import {
  forkSessionActorStoredState,
  readSessionActorTransactionState,
  replaceSessionActorStoredEntry,
  withSessionActorTransactionState,
} from "./session-actor-transaction.js";
import { registerSessionActorTranscriptRewriteOwner } from "./session-actor-transcript-publication.worker.js";
import { readSessionEntryPatchPredicate } from "./session-entry-patch-guard.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type { SessionParticipantRecord } from "./session-membership-facts.types.js";
import { readStagedSessionTranscriptAuthority } from "./session-transcript-authority.js";
import { prepareSessionTurnPredicates } from "./session-turn-predicate.js";
import { prepareVoiceTranscriptCommit } from "./session-turn.worker.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

type Command = SqliteWorkerCommand<SessionActorOperations>;

function transcriptPayloadBytes(command: Command): number | undefined {
  if (
    command.type !== "session.actor.appendTranscriptEvent" &&
    command.type !== "session.actor.appendToolResult"
  ) {
    return undefined;
  }
  const input = command.input;
  if (input.append) {
    const append = input.append;
    if (append.kind === "message") {
      return Buffer.byteLength(append.input.messageJson);
    }
    return (
      Buffer.byteLength(
        typeof append.input.event === "string"
          ? append.input.event
          : JSON.stringify(append.input.event),
      ) + Buffer.byteLength(append.input.message?.messageJson ?? "")
    );
  }
  if ("eventJson" in input) {
    return Buffer.byteLength(input.eventJson);
  }
  return input.turn.options.messages.reduce(
    (bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row.message)),
    0,
  );
}

function errorFacts(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "Session actor command failed" };
}

/** One instance belongs to the already serialized physical agent execution worker. */
export function createSessionActorWorker(
  context: AgentWorkerOperationContext,
  physicalIdentity: () => SessionActorTarget["database"],
) {
  const residents = createSessionActorResidency();
  const pendingStates = new Map<string, SessionActorStoredState>();
  let closed = false;
  const scopes = (target: SessionActorTarget, sessionIds: readonly string[] = []) => [
    ...collectSessionEntryLookupKeys(target.sessionKey),
    ...sessionIds.map(sqliteSessionIdWriteScope),
  ];
  const token = (
    database: Pick<OpenClawAgentDatabase, "db">,
    target: SessionActorTarget,
    sessionIds?: readonly string[],
  ) => readSqliteDatabaseScopedWriteToken(database.db, scopes(target, sessionIds));
  const retainedState = (database: Pick<OpenClawAgentDatabase, "db">, sessionKey: string) => {
    if (closed) {
      return undefined;
    }
    const pending = database.db.isTransaction ? pendingStates.get(sessionKey) : undefined;
    if (pending) {
      return pending.hot.writeToken ===
        readSqliteDatabasePendingScopedWriteToken(
          database.db,
          scopes(pending.hot.target, pending.hot.dependencySessionIds),
        )
        ? pending
        : undefined;
    }
    const resident = residents.get(sessionKey);
    return resident &&
      resident.hot.writeToken ===
        readSqliteDatabasePendingScopedWriteToken(
          database.db,
          scopes(resident.hot.target, resident.hot.dependencySessionIds),
        )
      ? resident
      : undefined;
  };
  const stageResidentState = (
    database: Pick<OpenClawAgentDatabase, "db">,
    working: SessionActorStoredState,
  ) => {
    const sessionKey = working.hot.target.sessionKey;
    const previousPending = pendingStates.get(sessionKey);
    return stageSqliteTransactionState(sqlPublicationAnchor(database.db), {
      stage: () => pendingStates.set(sessionKey, working),
      rollback() {
        if (previousPending) {
          pendingStates.set(sessionKey, previousPending);
        } else {
          pendingStates.delete(sessionKey);
        }
      },
      commit() {
        residents.remember(working);
        pendingStates.delete(sessionKey);
      },
      invalidate() {
        pendingStates.delete(sessionKey);
        residents.drop(sessionKey);
      },
    });
  };
  const prepareParticipantUpdate = (
    database: Pick<OpenClawAgentDatabase, "db">,
    sessionKey: string,
    singleStatement = false,
  ) => {
    const transaction = readSessionActorTransactionState(database, { sessionKey });
    if (transaction?.hot.target.sessionKey === sessionKey) {
      return {
        version: transaction.hot.version,
        publish: (participants: SessionParticipantRecord[]) => {
          replaceSessionActorParticipants(transaction, participants);
        },
      };
    }
    const before = retainedState(database, sessionKey);
    if (!before) {
      return undefined;
    }
    const version = { ...before.hot.version, sequence: before.hot.version.sequence + 1 };
    return {
      version,
      publish: (participants: SessionParticipantRecord[]) => {
        const working = forkSessionActorStoredState(before);
        replaceSessionActorParticipants(working, participants);
        working.hot.version = version;
        if (singleStatement) {
          stageSqliteTransactionState(sqlPublicationAnchor(database.db), {
            stage() {},
            rollback() {},
            commit() {
              const committedToken = token(
                database,
                working.hot.target,
                working.hot.dependencySessionIds,
              );
              if (committedToken === undefined) {
                throw new Error("Session actor lost its committed participant revision");
              }
              working.hot.writeToken = committedToken;
              residents.remember(working);
            },
            invalidate: () => residents.drop(sessionKey),
          });
          return;
        }
        const pendingToken = readSqliteDatabasePendingScopedWriteToken(
          database.db,
          scopes(working.hot.target, working.hot.dependencySessionIds),
        );
        if (pendingToken === undefined) {
          return;
        }
        working.hot.writeToken = pendingToken;
        stageResidentState(database, working);
      },
    };
  };
  const registerParticipantOwner = (database: OpenClawAgentDatabase) =>
    registerSessionActorParticipantOwner(database, {
      read: (opened, sessionKey) => retainedState(opened, sessionKey)?.hot.participants,
      prepare: prepareParticipantUpdate,
    });
  const prepareEntryPatch = (database: OpenClawAgentDatabase, sessionKey: string) => {
    const before = retainedState(database, sessionKey);
    const selected = before?.entryRows.get(sessionKey);
    if (!before?.hot.entry || !selected) {
      return undefined;
    }
    const previousEntry = before.hot.entry;
    const publish = (
      postimages: SessionEntryWritePostimages,
      publication: SessionEntryReplacementPublication,
    ) => {
      const postimage = postimages.get(sessionKey);
      if (
        !postimage ||
        postimage.entry.sessionId !== previousEntry.sessionId ||
        postimage.entry.lifecycleRevision !== previousEntry.lifecycleRevision
      ) {
        return;
      }
      const working = forkSessionActorStoredState(before);
      replaceSessionActorStoredEntry(working, sessionKey, {
        entry: postimage.entry,
        row: {
          ...postimage.row,
          member_ids_json: postimage.sideTables.memberIdsJson,
          board_present: postimage.sideTables.hasBoard ? 1 : 0,
        },
        window: postimage.window,
      });
      working.hasBoard = working.hot.hasBoard = postimage.sideTables.hasBoard;
      working.hot.version = { ...before.hot.version, sequence: before.hot.version.sequence + 1 };
      const pendingToken = readSqliteDatabasePendingScopedWriteToken(
        database.db,
        scopes(working.hot.target, working.hot.dependencySessionIds),
      );
      if (pendingToken === undefined) {
        return;
      }
      working.hot.writeToken = pendingToken;
      if (stageResidentState(database, working)) {
        publication.actorPostimages = new Map([
          [sessionKey, freezeJsonSnapshot(structuredClone(working.hot))],
        ]);
      }
    };
    return {
      snapshot: () =>
        captureSessionEntrySnapshot({
          entry: structuredClone(previousEntry),
          row: {
            ...structuredClone(selected.row),
            window: before.window ? structuredClone(before.window) : null,
            member_ids_json: JSON.stringify(before.hot.members.map((member) => member.identityId)),
            board_present: before.hasBoard ? 1 : 0,
            transcriptWatermark: {
              sessionId: previousEntry.sessionId,
              ...before.hot.transcript.watermark,
            },
          },
        }),
      readPredicate: (predicate: Parameters<typeof readSessionEntryPatchPredicate>[2]) =>
        withSessionActorTransactionState(database, before, () =>
          readSessionEntryPatchPredicate(database, sessionKey, predicate, {
            sessionId: previousEntry.sessionId,
            watermark: before.hot.transcript.watermark,
          }),
        ),
      publish,
    };
  };
  const registerTranscriptRewriteOwner = (database: OpenClawAgentDatabase) =>
    registerSessionActorTranscriptRewriteOwner(database, {
      read(opened, scope) {
        // Active actor mutations consume their working facts through the transaction kernels.
        if (readSessionActorTransactionState(opened)) {
          return undefined;
        }
        return retainedState(opened, scope.sessionKey);
      },
      rewrite(opened, rewrite, run) {
        const before = residents.get(rewrite.sessionKey);
        if (
          closed ||
          readSessionActorTransactionState(opened) ||
          before?.hot.entry?.sessionId !== rewrite.sessionId ||
          before.hot.writeToken !==
            readSqliteDatabasePendingScopedWriteToken(
              opened.db,
              scopes(before.hot.target, before.hot.dependencySessionIds),
            )
        ) {
          return run();
        }
        const working = forkSessionActorStoredState(before);
        rewriteSessionActorContextMetadata(working, rewrite.rows);
        working.hot.version = { ...before.hot.version, sequence: before.hot.version.sequence + 1 };
        return withSessionActorTransactionState(opened, working, run, (authority) => {
          working.hot = projectSessionActorHotState(working);
          const pendingToken = readSqliteDatabasePendingScopedWriteToken(
            opened.db,
            scopes(working.hot.target, working.hot.dependencySessionIds),
          );
          if (pendingToken === undefined) {
            return authority;
          }
          working.hot.writeToken = pendingToken;
          const mutationRevision = readSqliteNativeMutationRevision(opened.db);
          if (
            !stageSqliteTransactionState(sqlPublicationAnchor(opened.db), {
              stage() {},
              rollback() {},
              commit() {
                // A later nested writer must not install this intermediate transcript.
                if (readSqliteNativeMutationRevision(opened.db) === mutationRevision) {
                  residents.remember(working);
                } else {
                  residents.drop(rewrite.sessionKey);
                }
              },
              invalidate: () => residents.drop(rewrite.sessionKey),
            })
          ) {
            return authority;
          }
          return {
            ...authority,
            actorRewrite: freezeJsonSnapshot(
              structuredClone({
                before: before.hot.transcript.version,
                postimage: working.hot,
                rows: rewrite.rows,
              }),
            ),
          };
        });
      },
    });
  const requireTarget = (target: SessionActorTarget) => {
    const current = physicalIdentity();
    const requested = target.database;
    const matches =
      current.kind === "file" &&
      requested.kind === "file" &&
      current.physicalIdentity === requested.physicalIdentity &&
      current.birthtime === requested.birthtime &&
      current.nativeLocation === requested.nativeLocation;
    if (closed || !matches) {
      throw new Error("Session actor lost its physical database owner");
    }
  };
  const read = (
    database: OpenClawAgentDatabase,
    target: SessionActorTarget,
  ): SessionActorStoredState => {
    const resident = residents.get(target.sessionKey);
    const currentToken = token(database, target, resident?.hot.dependencySessionIds);
    if (!currentToken) {
      // The shared fence can belong to another session; retain this preimage privately.
      throw new Error("Session actor has an unsettled database writer");
    }
    if (resident?.hot.writeToken === currentToken) {
      residents.touch(target.sessionKey);
      return resident;
    }
    residents.drop(target.sessionKey);
    const hydrated = hydrateSessionActorState(
      database,
      target,
      { epoch: randomUUID(), sequence: 0 },
      currentToken,
    );
    const hydratedToken = token(database, target, hydrated.hot.dependencySessionIds);
    // Hydration is synchronous in the serialized execution owner.
    hydrated.hot.writeToken = hydratedToken!;
    residents.remember(hydrated);
    return hydrated;
  };
  return {
    async prepare(command: Command) {
      if (command.type === "session.actor.read") {
        return;
      }
      await prepareSessionTurnPredicates();
      if ("turn" in command.input && command.input.turn?.options.voiceTranscript) {
        await prepareVoiceTranscriptCommit();
      }
    },
    execute(command: Command): SessionActorOperations[keyof SessionActorOperations]["output"] {
      // SAFETY: Every command in the closed operations union uses this prefix and a phase or read suffix.
      const phase = command.type.slice("session.actor.".length) as SessionActorPhase | "read";
      const observed = observeSessionActorCommand(phase);
      const target = command.input.target;
      let database: OpenClawAgentDatabase | undefined;
      let committed = false;
      let stale: Extract<SessionActorOutcome<never>, { kind: "stale-version" }> | undefined;
      try {
        requireTarget(target);
        if (command.type === "session.actor.read") {
          database = context.open();
          registerSessionActorEntryPatchOwner(database, prepareEntryPatch);
          registerParticipantOwner(database);
          registerTranscriptRewriteOwner(database);
          const before = read(database, target);
          context.admit("transaction", {
            kind: "session-actor-admission",
            snapshot: projectSessionActorAuthority(before.hot),
          });
          observed.settled("read");
          return structuredClone(before.hot);
        }
        const payloadBytes = transcriptPayloadBytes(command);
        const diagnosticContext: Record<string, number | boolean | undefined> = { payloadBytes };
        const apply = (opened: OpenClawAgentDatabase) => {
          database = opened;
          registerSessionActorEntryPatchOwner(opened, prepareEntryPatch);
          registerParticipantOwner(opened);
          registerTranscriptRewriteOwner(opened);
          const admit = (stage: "transaction" | "commit", publication: unknown) => {
            const revision = readSqliteNativeMutationRevision(opened.db);
            withoutSqliteDatabaseWriteScope(opened.db, () => context.admit(stage, publication));
            if (readSqliteNativeMutationRevision(opened.db) !== revision) {
              throw new Error("Session actor database changed during authority admission");
            }
          };
          // The writer owns both hydration and version validation. A replica miss
          // never requires a separate read command before this transaction.
          let phaseStarted = performance.now();
          const recordPhase = (label: string) => {
            const now = performance.now();
            diagnosticContext[label] = Math.round(now - phaseStarted);
            phaseStarted = now;
          };
          const resident = residents.get(target.sessionKey);
          const before = read(opened, target);
          recordPhase("actorReadMs");
          diagnosticContext.actorResident = before === resident;
          diagnosticContext.actorTranscriptEvents = before.transcript.identities.size;
          diagnosticContext.actorActiveEvents = before.transcript.active.size;
          admit("transaction", {
            kind: "session-actor-admission",
            snapshot: projectSessionActorAuthority(before.hot),
          });
          if (
            command.input.expected !== undefined &&
            !isDeepStrictEqual(before.hot.version, command.input.expected)
          ) {
            const error = new Error("Session actor version changed before command admission");
            error.name = "SessionActorStaleVersionError";
            stale = {
              kind: "stale-version",
              expected: command.input.expected,
              postimage: structuredClone(before.hot),
              error: errorFacts(error),
            };
            throw error;
          }
          const working = forkSessionActorStoredState(before);
          let commitPublication: unknown;
          const borrowed: AgentWorkerOperationContext = {
            ...context,
            open: () => opened,
            writeTransaction(_label, _owner, operation) {
              if (!opened.db.isTransaction) {
                throw new Error("Session actor kernel escaped its transaction");
              }
              return operation(opened);
            },
            admit(stage, publication) {
              if (stage === "commit") {
                commitPublication = publication;
                // An append shares this transaction and message owner. Its final
                // custody check joins the actor's grant immediately before COMMIT.
                if (isRecord(publication) && publication.kind === "session-message") {
                  return;
                }
              }
              admit(stage, {
                kind: "session-actor-admission",
                snapshot: projectSessionActorAuthority(working.hot),
                publication,
              });
            },
          };
          return withSessionActorTransactionState(opened, working, () => {
            phaseStarted = performance.now();
            const applied = applySessionActorPhase(command, working, borrowed);
            recordPhase("actorApplyMs");
            const { value } = applied;
            working.hot.version = {
              epoch: before.hot.version.epoch,
              sequence: before.hot.version.sequence + 1,
            };
            working.hot = projectSessionActorHotState(working);
            recordPhase("actorProjectionMs");
            const pendingToken = readSqliteDatabasePendingScopedWriteToken(
              opened.db,
              scopes(target, working.hot.dependencySessionIds),
            );
            if (pendingToken === undefined) {
              throw new Error("Session actor lost its native writer revision");
            }
            working.hot.writeToken = pendingToken;
            const accepted = createSessionActorCommittedOutcome({
              // SAFETY: The read command returned before entering this write transaction.
              phase: phase as SessionActorPhase,
              command: command.input,
              before: before.hot,
              after: working.hot,
              payloads: working.transcript.payloads,
              transcriptAuthority: readStagedSessionTranscriptAuthority(opened),
              applied,
            });
            if (
              !stageSqliteTransactionState(sqlPublicationAnchor(opened.db), {
                stage() {},
                rollback() {},
                commit() {
                  committed = true;
                  residents.remember(working);
                },
                invalidate() {
                  residents.drop(target.sessionKey);
                },
              })
            ) {
              throw new Error("Session actor requires managed transaction settlement");
            }
            const turn =
              value && "kind" in value && value.kind === "session-turn"
                ? value
                : value && "turn" in value
                  ? value.turn
                  : undefined;
            const serialized = serialize(accepted);
            diagnosticContext.actorReceiptBytes = serialized.byteLength;
            if (serialized.byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
              const transfer = createSqliteWorkerTransferOwner();
              const handle = transfer.start([{ kind: "outcome", serialized }].values(), {
                kinds: ["outcome"],
              });
              try {
                let frame = transfer.next(handle.id);
                let finalFrames;
                for (;;) {
                  const next = transfer.next(handle.id);
                  if (next.done) {
                    finalFrames = [frame, next];
                    break;
                  }
                  admit("transaction", {
                    kind: "session-actor-admission",
                    snapshot: projectSessionActorAuthority(working.hot),
                    publication: {
                      kind: "session-actor-outcome",
                      transfer: { handle, frames: [frame] },
                    },
                  });
                  frame = next;
                }
                const receipt = {
                  kind: "session-actor-committed-transfer" as const,
                  transferId: handle.id,
                };
                deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(opened.db), receipt);
                recordPhase("actorReceiptMs");
                admit("commit", {
                  kind: "session-actor-admission",
                  snapshot: projectSessionActorAuthority(working.hot),
                  publication: {
                    kind: "session-actor-outcome",
                    transfer: { handle, frames: finalFrames },
                    publication: turn ?? commitPublication,
                  },
                  final: true,
                });
                return { kind: "committed" as const };
              } finally {
                transfer.cancel();
              }
            }
            deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(opened.db), accepted);
            recordPhase("actorReceiptMs");
            admit("commit", {
              kind: "session-actor-admission",
              snapshot: projectSessionActorAuthority(working.hot),
              publication: turn ?? commitPublication,
              final: true,
            });
            return { kind: "committed" as const };
          });
        };
        const outcome = context.writeTransaction(
          `session.actor.${phase}`,
          "Session actor",
          apply,
          diagnosticContext,
        );
        observed.settled(outcome.kind);
        return outcome;
      } catch (error) {
        if (command.type === "session.actor.read") {
          observed.settled("rejected");
          throw error;
        }
        if (committed) {
          observed.settled("committed");
          return { kind: "committed", failure: errorFacts(error) };
        }
        let unsettled = hasSqliteWorkerOutcomeUnknown(error);
        if (database) {
          try {
            // The transaction owner retires the handle if rollback cannot establish settlement.
            assertTransactionUsable(database.db);
            unsettled ||= database.db.isTransaction || !database.db.isOpen;
          } catch {
            unsettled = true;
          }
        }
        if (unsettled) {
          residents.drop(target.sessionKey);
          observed.settled("unknown");
          return {
            kind: "unknown",
            target,
            commandId: command.input.commandId,
            error: errorFacts(error),
          };
        }
        const retained = residents.get(target.sessionKey);
        if (retained && database) {
          const currentToken = token(database, target, retained.hot.dependencySessionIds);
          if (currentToken !== undefined && currentToken !== retained.hot.writeToken) {
            residents.drop(target.sessionKey);
          }
        }
        if (stale) {
          observed.settled("stale-version");
          return stale;
        }
        observed.settled("rolled-back");
        return {
          kind: "rolled-back",
          error: errorFacts(error),
          ...(error instanceof SessionActorStaleStateError
            ? { reason: "stale-state" as const }
            : {}),
        };
      }
    },
    close() {
      // Commands are synchronous. The execution owner drains accepted requests before close;
      // staged reducers remain with retained host phases and must settle before their release.
      closed = true;
      residents.clear();
      pendingStates.clear();
    },
  };
}

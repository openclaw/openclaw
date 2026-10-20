import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  wrapSqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionRequest,
  SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerTransferCollector } from "../../infra/sqlite-worker-transfer.js";
import {
  parseConversationPublications,
  retainConversationWorkerPublication,
} from "./session-accessor.sqlite-conversation-publication.js";
import { publishRetainedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  captureSessionEntryMaintenanceAgeChange,
  publishSessionEntryMaintenanceAgeChanges,
} from "./session-accessor.sqlite-maintenance-age.js";
import type {
  SessionActorAuthority,
  SessionActorAuthorityFacts,
  SessionActorCommandContext,
  SessionActorCommitObserver,
  SessionActorHotState,
  SessionActorOperations,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorPhaseInputs,
  SessionActorPhaseResults,
  SessionActorTarget,
} from "./session-actor-contract.js";
import type { SessionActorExecutor, SessionActorExecutorGuards } from "./session-actor-executor.js";
import { SessionActorReadInvalidatedError } from "./session-actor-read-error.js";
import type { createSessionActorReplica } from "./session-actor-replica.js";
import { publishCommittedSessionTranscriptReceipts } from "./session-transcript-authority.js";

type NativeAdmission = {
  admission: Pick<SqliteWorkerOperationAdmission, "committed" | "settlement"> &
    Partial<Pick<SqliteWorkerOperationAdmission, "failure" | "failureSource">>;
  retained: RetainedWorkerTransactionAdmission;
};

export type SessionActorTransport = {
  /** The existing physical writer queue owns serialization, including warm reads. */
  run<T>(
    operation: (scope: {
      execute: SqliteWorkerStore<SessionActorOperations>["execute"];
    }) => Promise<T>,
    authorize: (
      request: SqliteWorkerAdmissionRequest,
      native: NativeAdmission,
      grant: () => boolean,
    ) => void,
    concurrentBoardReads?: "transcript-only",
  ): Promise<T>;
  /** Read-only committed evidence; follow-up work runs after releasing the command FIFO. */
  afterCommitted?<Value extends SessionActorPhaseResults[SessionActorPhase]>(
    outcome: Extract<SessionActorOutcome<Value>, { kind: "committed" }>,
  ): Promise<{ value: Value } | void>;
  /** Backend lifetime retention is independent of its per-command writer FIFO. */
  retain?<T>(operation: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
};

type TransportScope = Parameters<Parameters<SessionActorTransport["run"]>[0]>[0];

const executePhase: {
  [Phase in SessionActorPhase]: (
    scope: TransportScope,
    input: SessionActorCommandContext &
      SessionActorPhaseInputs[Phase] & { target: SessionActorTarget },
  ) => Promise<SessionActorOperations[`session.actor.${Phase}`]["output"]>;
} = {
  acceptInput: (scope, input) => scope.execute({ type: "session.actor.acceptInput", input }),
  adoptRun: (scope, input) => scope.execute({ type: "session.actor.adoptRun", input }),
  appendToolResult: (scope, input) =>
    scope.execute({ type: "session.actor.appendToolResult", input }),
  appendTranscriptEvent: (scope, input) =>
    scope.execute({ type: "session.actor.appendTranscriptEvent", input }),
  completeTurn: (scope, input) => scope.execute({ type: "session.actor.completeTurn", input }),
  deliveryPending: (scope, input) =>
    scope.execute({ type: "session.actor.deliveryPending", input }),
  deliverySettled: (scope, input) =>
    scope.execute({ type: "session.actor.deliverySettled", input }),
  patch: (scope, input) => scope.execute({ type: "session.actor.patch", input }),
};

function errorFacts(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "Session actor operation failed" };
}

/** SQLite admission and settlement stay with the durable transport. */
export function createSqliteSessionActorExecutor(
  params: {
    target: SessionActorTarget;
    transport: SessionActorTransport;
    replica: ReturnType<typeof createSessionActorReplica>;
  } & SessionActorExecutorGuards,
): SessionActorExecutor {
  const { target } = params;
  let fenced: Extract<SessionActorOutcome<never>, { kind: "unknown" }>["error"] | undefined;
  const authorize = (
    authority: SessionActorAuthority,
    observe?: (
      native: NativeAdmission,
      publication: unknown,
      stage: "transaction" | "commit",
      snapshot: SessionActorAuthorityFacts,
    ) => void,
    beforeFinalGrant?: (conversationPublication: unknown) => void,
  ) => {
    let actorAdmissionSeen = false;
    return (
      request: SqliteWorkerAdmissionRequest,
      native: NativeAdmission,
      grant: () => boolean,
    ) => {
      params.assertAccepted();
      authority.assertCurrent();
      const facts =
        isRecord(request.facts) &&
        request.facts.kind !== "session-actor-admission" &&
        Object.hasOwn(request.facts, "publication")
          ? request.facts.publication
          : request.facts;
      if (isRecord(facts) && facts.kind === "session-actor-admission") {
        actorAdmissionSeen = true;
        if (
          (request.stage !== "transaction" && request.stage !== "commit") ||
          !isRecord(facts.snapshot) ||
          !isDeepStrictEqual(facts.snapshot.target, target)
        ) {
          throw new Error("Session actor admission belongs to another target");
        }
        // SAFETY: The private MessagePort already detached this snapshot from the paired kernel.
        const snapshot = facts.snapshot as SessionActorAuthorityFacts;
        const publication = facts.publication;
        observe?.(native, publication, request.stage, snapshot);
        authority.authorize(
          request.stage,
          snapshot,
          isRecord(publication) && publication.kind === "session-actor-outcome"
            ? publication.publication
            : publication,
        );
      } else if (
        actorAdmissionSeen &&
        (request.stage === "commit" || (request.stage === "transaction" && facts !== undefined))
      ) {
        throw new Error("Session actor command omitted its admission evidence");
      }
      authority.assertCurrent();
      params.assertAccepted();
      if (
        request.stage === "commit" &&
        isRecord(facts) &&
        facts.kind === "session-actor-admission" &&
        facts.final === true
      ) {
        beforeFinalGrant?.(facts.conversationPublication);
      }
      if (!grant()) {
        throw new Error("Session actor authority expired");
      }
    };
  };
  const read = async (authority: SessionActorAuthority) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await params.transport.run(async (scope) => {
          params.assertReadable();
          authority.assertCurrent();
          let snapshot = params.replica.read();
          if (!snapshot) {
            const install = params.replica.beginRead();
            snapshot = await scope.execute({ type: "session.actor.read", input: { target } });
            install(snapshot);
            // Disclose the immutable installed revision, including a superseding receipt.
            snapshot = params.replica.read();
          }
          if (!snapshot) {
            throw new SessionActorReadInvalidatedError();
          }
          fenced = undefined;
          params.assertReadable();
          authority.assertCurrent();
          authority.authorize("commit", snapshot);
          authority.assertCurrent();
          params.assertReadable();
          // Policy callbacks do not write session state. A synchronous bookkeeping
          // change during authorization is visible to the next read.
          return snapshot;
        }, authorize(authority));
      } catch (error) {
        // No command was accepted. Reenter the physical FIFO once with fresh
        // caller authority after a newer publication revoked the read.
        if (attempt > 0 || !(error instanceof SessionActorReadInvalidatedError)) {
          throw error;
        }
      }
    }
  };
  const command = async <Phase extends SessionActorPhase>(
    name: Phase,
    input: SessionActorCommandContext & SessionActorPhaseInputs[Phase],
    authority: SessionActorAuthority,
    observer?: SessionActorCommitObserver<SessionActorPhaseResults[Phase]>,
  ): Promise<SessionActorOutcome<SessionActorPhaseResults[Phase]>> => {
    const captured = input;
    type Outcome = SessionActorOutcome<SessionActorPhaseResults[Phase]>;
    let native: NativeAdmission | undefined;
    let previousEntry: SessionActorAuthorityFacts["entry"];
    let capturedPreviousEntry = false;
    let running: Promise<Outcome> | undefined;
    let committed: Extract<Outcome, { kind: "committed" }> | undefined;
    let candidate: unknown;
    const conversation =
      target.database.kind === "file"
        ? retainConversationWorkerPublication(
            target.database.physicalIdentity,
            target.database.nativeLocation,
          )
        : undefined;
    const transfer = createSqliteWorkerTransferCollector("outcome", (value) => {
      if (candidate !== undefined) {
        throw new Error("Session actor transferred more than one outcome");
      }
      candidate = value;
    });
    const unknown = (error: unknown): Outcome => {
      if (target.database.kind === "file") {
        publishRetainedSessionEntryChange(
          target.database.physicalIdentity,
          target.sessionKey,
          undefined,
          previousEntry,
          false,
        );
      }
      return {
        kind: "unknown",
        target,
        commandId: captured.commandId,
        error: { ...errorFacts(error), cause: error },
      };
    };
    const preserveFailure = (error: unknown, origin?: "response"): Outcome => {
      if (!committed) {
        return unknown(error);
      }
      const failure = { ...errorFacts(error), ...(origin ? { origin } : {}) };
      committed = {
        ...committed,
        failure: committed.failure
          ? {
              name: "AggregateError",
              message: `${committed.failure.message}; ${failure.message}`,
            }
          : failure,
      };
      return committed;
    };
    let outcome: Outcome;
    try {
      outcome = await params.transport.run(
        (scope) => {
          running = (async (): Promise<Outcome> => {
            if (fenced) {
              return unknown(
                new Error("Session actor requires reconciliation before another command", {
                  cause: fenced.cause,
                }),
              );
            }
            const pending = params.replica.beginCommand();
            const reply = await executePhase[name](scope, { ...captured, target }).then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            );
            const unconfirmed = (message: string, settlementFailure?: unknown) => {
              const facts = reply.ok ? { message } : errorFacts(reply.error);
              return unknown(
                Object.assign(
                  wrapSqliteWorkerError(
                    facts.message,
                    undefined,
                    reply.ok
                      ? reply.value.kind !== "committed"
                        ? reply.value.error
                        : undefined
                      : reply.error,
                    settlementFailure,
                  ),
                  facts,
                ),
              );
            };
            let result: Outcome;
            if (native) {
              const settled = await native.retained.settled;
              const witness = native.admission.committed?.facts;
              const evidence =
                isRecord(witness) && witness.kind === "session-actor-committed-transfer"
                  ? transfer.completed && witness.transferId === transfer.id
                    ? candidate
                    : undefined
                  : witness;
              const receipt = isRecord(evidence) ? evidence.receipt : undefined;
              if (
                isRecord(evidence) &&
                evidence.kind === "committed" &&
                isRecord(receipt) &&
                receipt.kind === "session-actor-committed" &&
                receipt.commandId === captured.commandId &&
                receipt.phaseId === captured.phaseId &&
                receipt.phase === name
              ) {
                // SAFETY: The paired worker constructs the typed result; native admission validates its settlement envelope.
                committed = evidence as Extract<Outcome, { kind: "committed" }>;
                if (!reply.ok) {
                  preserveFailure(reply.error, "response");
                } else if (reply.value.kind === "committed" && reply.value.failure) {
                  committed = { ...committed, failure: reply.value.failure };
                }
                result = committed;
                try {
                  conversation?.settle(committed.receipt.conversationPublication);
                  // Retained effect predicates must observe this commit before its callbacks.
                  if (target.database.kind === "file") {
                    const entry = committed.receipt.postimage.entry;
                    publishRetainedSessionEntryChange(
                      target.database.physicalIdentity,
                      target.sessionKey,
                      entry ? projectSessionSharingEntry(entry) : undefined,
                      previousEntry,
                      true,
                      entry,
                    );
                    if (entry) {
                      // Actor delivery settlement can release the last durable recovery claim.
                      const change = captureSessionEntryMaintenanceAgeChange({
                        sessionKey: target.sessionKey,
                        entry,
                        previousEntry,
                      });
                      if (!isDeepStrictEqual(change.entry, change.previousEntry)) {
                        publishSessionEntryMaintenanceAgeChanges(target.database.physicalIdentity, [
                          change,
                        ]);
                      }
                    }
                  }
                  // Partial transcript publication precedes installation of the full actor replica.
                  publishCommittedSessionTranscriptReceipts(
                    committed.receipt.transcript.authorityReceipts,
                  );
                  observer?.committed(committed);
                } catch (error) {
                  result = preserveFailure(error);
                }
              } else if (
                witness === undefined &&
                reply.ok &&
                (reply.value.kind === "rolled-back" || reply.value.kind === "stale-version") &&
                (settled.kind === "not-entered" ||
                  native.admission.settlement?.kind === "completed")
              ) {
                const failure = native.admission.failure;
                result =
                  native.admission.failureSource === "protocol" ||
                  hasSqliteWorkerOutcomeUnknown(failure)
                    ? unknown(failure)
                    : failure === undefined
                      ? reply.value
                      : { kind: "rolled-back", error: errorFacts(failure) };
              } else {
                result = unconfirmed(
                  "Unconfirmed actor settlement",
                  settled.kind !== "completed" ? settled.error : undefined,
                );
              }
            } else if (reply.ok && reply.value.kind === "rolled-back") {
              result = reply.value;
            } else {
              result = unconfirmed("Actor command omitted native settlement");
            }
            if (result.kind !== "committed") {
              conversation?.settle(undefined, result.kind === "unknown");
            }
            if (result.kind === "unknown") {
              // Fence the FIFO with the initiating failure, not a later reconciliation refusal.
              fenced ??= result.error;
            }
            if (result.kind === "stale-version") {
              try {
                authority.assertCurrent();
                authority.authorize("commit", result.postimage);
                authority.assertCurrent();
                params.assertAccepted();
              } catch (error) {
                result = { kind: "rolled-back", error: errorFacts(error) };
              }
            }
            try {
              if (!pending.settle(result)) {
                params.replica.invalidate();
              }
              if (!native) {
                // Rejected before transaction admission can mean eviction or a new
                // worker epoch; a retained old version must not mask that miss.
                params.replica.invalidate();
              }
            } catch (error) {
              params.replica.invalidate();
              result = preserveFailure(error);
            }
            return result;
          })();
          return running;
        },
        authorize(
          authority,
          (admission, publication, stage, snapshot) => {
            native = admission;
            // Compound phases and transfer frames carry later snapshots of the same transaction.
            if (stage === "transaction" && !capturedPreviousEntry) {
              previousEntry = snapshot.entry;
              capturedPreviousEntry = true;
            }
            if (isRecord(publication) && publication.kind === "session-actor-outcome") {
              transfer.accept(publication.transfer);
            }
          },
          (publication) => {
            const receipts = parseConversationPublications(publication);
            if (!receipts) {
              throw new Error("Session actor commit omitted its conversation publication");
            }
            conversation?.begin(receipts);
          },
        ),
        (name === "appendTranscriptEvent" || name === "appendToolResult") &&
          "append" in captured &&
          captured.append !== undefined &&
          captured.append.initialization === undefined &&
          !captured.reducers?.length
          ? "transcript-only"
          : undefined,
      );
    } catch (error) {
      // A transport timeout is not native settlement. The accepted callback keeps
      // custody through its actual drain, even if the surrounding transport fails.
      if (running) {
        try {
          outcome = await running;
          if (outcome.kind === "committed") {
            outcome = preserveFailure(error);
          }
        } catch (settlementError) {
          if (native) {
            await native.retained.settled;
          }
          outcome = preserveFailure(settlementError);
        }
      } else {
        outcome = hasSqliteWorkerOutcomeUnknown(error)
          ? unknown(error)
          : {
              kind: "rolled-back",
              error: errorFacts(error),
            };
      }
      if (outcome.kind !== "committed") {
        conversation?.settle(undefined, outcome.kind === "unknown");
      }
      params.replica.invalidate();
    }
    if (outcome.kind === "committed" && params.transport.afterCommitted) {
      try {
        const prepared = await params.transport.afterCommitted(outcome);
        if (prepared) {
          committed = { ...outcome, value: prepared.value };
          outcome = committed;
        }
      } catch (error) {
        outcome = preserveFailure(error);
      }
    }
    if (outcome.kind === "unknown") {
      fenced ??= outcome.error;
      params.replica.invalidate();
    }
    return outcome;
  };
  const snapshot = (authority: SessionActorAuthority): SessionActorHotState | undefined => {
    params.assertReadable();
    authority.assertCurrent();
    const installed = fenced ? undefined : params.replica.read();
    if (installed) {
      authority.authorize("commit", installed);
      authority.assertCurrent();
      params.assertReadable();
    }
    return installed;
  };
  return {
    snapshot,
    read,
    command,
    retain: params.transport.retain?.bind(params.transport),
    async release() {
      params.replica.close();
      await params.transport.release();
    },
  };
}

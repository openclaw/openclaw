import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionRequest,
  SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
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
import type { createSessionActorReplica } from "./session-actor-replica.js";

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
  ): Promise<T>;
  /** Follow-up work may borrow other owners only after releasing the command FIFO. */
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
  ) => Promise<SessionActorOutcome<SessionActorPhaseResults[Phase]>>;
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
  let fenced = false;
  const authorize = (
    authority: SessionActorAuthority,
    observe?: (native: NativeAdmission) => void,
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
        authority.authorize(request.stage, structuredClone(snapshot), facts.publication);
        observe?.(native);
      } else if (
        actorAdmissionSeen &&
        (request.stage === "commit" || (request.stage === "transaction" && facts !== undefined))
      ) {
        throw new Error("Session actor command omitted its admission evidence");
      }
      authority.assertCurrent();
      params.assertAccepted();
      if (!grant()) {
        throw new Error("Session actor authority expired");
      }
    };
  };
  const read = (authority: SessionActorAuthority) =>
    params.transport.run(async (scope) => {
      params.assertReadable();
      authority.assertCurrent();
      let snapshot = params.replica.read();
      if (!snapshot) {
        const pending = params.replica.beginRead();
        try {
          snapshot = await scope.execute({ type: "session.actor.read", input: { target } });
          if (!pending.install(snapshot)) {
            // A committed receipt can supersede the read while its reply is in flight.
            snapshot = params.replica.read();
          }
        } finally {
          pending.cancel();
        }
      }
      if (!snapshot) {
        throw new Error("Session actor changed before its read could publish");
      }
      fenced = false;
      params.assertReadable();
      authority.assertCurrent();
      authority.authorize("commit", snapshot);
      authority.assertCurrent();
      params.assertReadable();
      // Policy callbacks do not write session state. A synchronous bookkeeping
      // change during authorization is visible to the next read.
      return snapshot;
    }, authorize(authority));
  const command = async <Phase extends SessionActorPhase>(
    name: Phase,
    input: SessionActorCommandContext & SessionActorPhaseInputs[Phase],
    authority: SessionActorAuthority,
    observer?: SessionActorCommitObserver<SessionActorPhaseResults[Phase]>,
  ): Promise<SessionActorOutcome<SessionActorPhaseResults[Phase]>> => {
    const captured = input;
    type Outcome = SessionActorOutcome<SessionActorPhaseResults[Phase]>;
    let native: NativeAdmission | undefined;
    let running: Promise<Outcome> | undefined;
    let committed: Extract<Outcome, { kind: "committed" }> | undefined;
    const unknown = (error: unknown): Outcome => ({
      kind: "unknown",
      target,
      commandId: captured.commandId,
      error: errorFacts(error),
    });
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
                new Error("Session actor requires reconciliation before another command"),
              );
            }
            const pending = params.replica.beginCommand();
            const reply = await executePhase[name](scope, { ...captured, target }).then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            );
            let result: Outcome;
            if (native) {
              const settled = await native.retained.settled;
              const evidence = native.admission.committed?.facts;
              const receipt = isRecord(evidence) ? evidence.receipt : undefined;
              if (
                isRecord(evidence) &&
                evidence.kind === "committed" &&
                isRecord(receipt) &&
                receipt.kind === "session-actor-committed" &&
                receipt.commandId === captured.commandId
              ) {
                // SAFETY: The paired worker constructs the typed result; native admission validates its settlement envelope.
                committed = structuredClone(evidence) as Extract<Outcome, { kind: "committed" }>;
                if (!reply.ok) {
                  preserveFailure(reply.error, "response");
                } else if (reply.value.kind === "committed" && reply.value.failure) {
                  committed = { ...committed, failure: structuredClone(reply.value.failure) };
                }
                result = committed;
                try {
                  observer?.committed(structuredClone(committed));
                } catch (error) {
                  result = preserveFailure(error);
                }
              } else if (
                evidence === undefined &&
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
                result = unknown(
                  reply.ok ? new Error("Unconfirmed actor settlement") : reply.error,
                );
              }
            } else if (reply.ok && reply.value.kind === "rolled-back") {
              result = reply.value;
            } else {
              result = unknown(
                reply.ok ? new Error("Actor command omitted native settlement") : reply.error,
              );
            }
            if (result.kind === "unknown") {
              // Fence before returning the physical FIFO permit to a queued command.
              fenced = true;
            }
            if (result.kind === "stale-version") {
              try {
                authority.assertCurrent();
                authority.authorize("commit", structuredClone(result.postimage));
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
        authorize(authority, (admission) => {
          native = admission;
        }),
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
      params.replica.invalidate();
    }
    if (outcome.kind === "committed" && params.transport.afterCommitted) {
      try {
        const prepared = await params.transport.afterCommitted(structuredClone(outcome));
        if (prepared) {
          committed = { ...outcome, value: prepared.value };
          outcome = committed;
        }
      } catch (error) {
        outcome = preserveFailure(error);
      }
    }
    if (outcome.kind === "unknown") {
      fenced = true;
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

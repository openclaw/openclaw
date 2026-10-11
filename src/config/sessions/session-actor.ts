import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionRequest,
  SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorCommandContext,
  SessionActorCommitObserver,
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorOperations,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorPhaseInputs,
  SessionActorPhaseResults,
  SessionActorReducer,
  SessionActorTarget,
} from "./session-actor-contract.js";
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
      captureGeneration(): { assertCurrent(): void };
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

type PhaseState = {
  id: string;
  active: boolean;
  reducers: SessionActorReducer[];
  pending: Set<Promise<unknown>>;
  uncertain: boolean;
};

function errorFacts(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "Session actor operation failed" };
}

/** Shared host lifetime and receipt protocol; storage adapters own only transport. */
export function createSessionActor(params: {
  target: SessionActorTarget;
  lifetime: SessionActorLifetime;
  transport: SessionActorTransport;
  replica: ReturnType<typeof createSessionActorReplica>;
}): SessionActor {
  const target = freezeJsonSnapshot(structuredClone(params.target));
  const accepted = new Set<Promise<unknown>>();
  let closing = false;
  let release: Promise<void> | undefined;
  let generation: { assertCurrent(): void } | undefined;
  let fenced = false;
  const assertAccepted = () => params.lifetime.assertCurrent();
  const assertReadable = () => {
    params.lifetime.assertAdmission?.();
    params.lifetime.assertReadable();
    if (closing) {
      throw new Error("Session actor is released");
    }
  };
  const assertCurrent = () => {
    assertAccepted();
    if (closing) {
      throw new Error("Session actor is released");
    }
  };
  const retain = <T>(operation: () => Promise<T>, phase?: PhaseState): Promise<T> => {
    if (phase) {
      assertAccepted();
      if (!phase.active) {
        throw new Error("Session actor phase is settled");
      }
    } else {
      params.lifetime.assertAdmission?.();
      assertCurrent();
    }
    const retained = Promise.withResolvers<T>();
    const promise = retained.promise;
    accepted.add(promise);
    phase?.pending.add(promise);
    const settled = () => {
      accepted.delete(promise);
      phase?.pending.delete(promise);
    };
    void promise.then(settled, settled);
    try {
      const work = params.transport.retain ? params.transport.retain(operation) : operation();
      void work.then(retained.resolve, retained.reject);
    } catch (error) {
      retained.reject(error);
    }
    return promise;
  };
  const checkGeneration = (scope: TransportScope) => {
    try {
      generation?.assertCurrent();
    } catch {
      params.replica.invalidate();
    }
    generation = scope.captureGeneration();
    generation.assertCurrent();
  };
  const isInstalled = (snapshot: SessionActorHotState): boolean => {
    try {
      generation?.assertCurrent();
    } catch {
      params.replica.invalidate();
      return false;
    }
    const current = params.replica.read();
    return (
      current !== undefined &&
      current.writeToken === snapshot.writeToken &&
      isDeepStrictEqual(current.version, snapshot.version)
    );
  };
  const authorize = (
    authority: SessionActorAuthority,
    observe?: (
      native: NativeAdmission,
      stage: "transaction" | "commit",
      state: SessionActorHotState,
      final: boolean,
    ) => void,
  ) => {
    let actorAdmissionSeen = false;
    return (
      request: SqliteWorkerAdmissionRequest,
      native: NativeAdmission,
      grant: () => boolean,
    ) => {
      assertAccepted();
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
        // SAFETY: The paired actor kernel supplies this full snapshot on its private admission port.
        const snapshot = structuredClone(facts.snapshot) as SessionActorHotState;
        authority.authorize(request.stage, structuredClone(snapshot), facts.publication);
        observe?.(native, request.stage, structuredClone(snapshot), facts.final === true);
      } else if (
        actorAdmissionSeen &&
        (request.stage === "commit" || (request.stage === "transaction" && facts !== undefined))
      ) {
        throw new Error("Session actor command omitted its admission evidence");
      }
      authority.assertCurrent();
      assertAccepted();
      if (!grant()) {
        throw new Error("Session actor authority expired");
      }
    };
  };
  const read = (authority: SessionActorAuthority, phase?: PhaseState) =>
    retain(
      () =>
        params.transport.run(async (scope) => {
          checkGeneration(scope);
          assertReadable();
          authority.assertCurrent();
          let snapshot = params.replica.read();
          if (!snapshot) {
            const pending = params.replica.beginRead();
            try {
              snapshot = await scope.execute({ type: "session.actor.read", input: { target } });
              generation?.assertCurrent();
              if (!pending.install(snapshot)) {
                throw new Error("Session actor changed before its read could publish");
              }
              fenced = false;
            } finally {
              pending.cancel();
            }
          }
          assertReadable();
          authority.assertCurrent();
          authority.authorize("commit", snapshot);
          authority.assertCurrent();
          assertReadable();
          if (!isInstalled(snapshot)) {
            throw new Error("Session actor changed before read disclosure");
          }
          return snapshot;
        }, authorize(authority)),
      phase,
    );
  const command = <Phase extends SessionActorPhase>(
    name: Phase,
    input: SessionActorCommandContext & SessionActorPhaseInputs[Phase],
    authority: SessionActorAuthority,
    observer?: SessionActorCommitObserver<SessionActorPhaseResults[Phase]>,
    phase?: PhaseState,
  ): Promise<SessionActorOutcome<SessionActorPhaseResults[Phase]>> => {
    const captured = structuredClone(input);
    if (phase && captured.phaseId !== phase.id) {
      throw new Error("Session actor command belongs to another phase");
    }
    return retain(async () => {
      type Outcome = SessionActorOutcome<SessionActorPhaseResults[Phase]>;
      const reducers = phase?.reducers.splice(0) ?? [];
      captured.reducers = [...reducers, ...(captured.reducers ?? [])];
      const selected: {
        native?: NativeAdmission;
        transactionSnapshot?: SessionActorHotState;
        commitSnapshot?: SessionActorHotState;
      } = {};
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
              checkGeneration(scope);
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
              const native = selected.native;
              let result: Outcome;
              if (native) {
                const settled = await native.retained.settled;
                const evidence = native.admission.committed?.facts;
                const receipt = isRecord(evidence) ? evidence.receipt : undefined;
                if (
                  isRecord(evidence) &&
                  evidence.kind === "committed" &&
                  isRecord(receipt) &&
                  selected.transactionSnapshot !== undefined &&
                  selected.commitSnapshot !== undefined &&
                  receipt.kind === "session-actor-committed" &&
                  receipt.commandId === captured.commandId &&
                  receipt.phaseId === captured.phaseId &&
                  receipt.phase === name &&
                  isDeepStrictEqual(receipt.beforeVersion, selected.transactionSnapshot.version) &&
                  (captured.expected === undefined ||
                    isDeepStrictEqual(receipt.beforeVersion, captured.expected)) &&
                  isDeepStrictEqual(receipt.afterVersion, selected.commitSnapshot.version) &&
                  selected.commitSnapshot.version.epoch ===
                    selected.transactionSnapshot.version.epoch &&
                  selected.commitSnapshot.version.sequence ===
                    selected.transactionSnapshot.version.sequence + 1 &&
                  isDeepStrictEqual(receipt.postimage, selected.commitSnapshot)
                ) {
                  // SAFETY: The paired native receipt owns the result type; the checks above match its command and postimage.
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
                  (reply.value.kind === "rolled-back" ||
                    (reply.value.kind === "stale-version" &&
                      captured.expected !== undefined &&
                      isDeepStrictEqual(reply.value.expected, captured.expected) &&
                      isDeepStrictEqual(reply.value.postimage, selected.transactionSnapshot) &&
                      !isDeepStrictEqual(reply.value.postimage.version, captured.expected))) &&
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
                  assertAccepted();
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
          authorize(authority, (native, stage, snapshot, final) => {
            selected.native = native;
            if (stage === "transaction") {
              selected.transactionSnapshot ??= snapshot;
            }
            if (stage === "commit" && final) {
              selected.commitSnapshot = snapshot;
            }
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
            if (selected.native) {
              await selected.native.retained.settled;
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
        if (phase) {
          phase.uncertain = true;
        }
      } else if (phase && (outcome.kind === "rolled-back" || outcome.kind === "stale-version")) {
        phase.reducers.unshift(...reducers);
      }
      return outcome;
    }, phase);
  };
  const releaseActor = (): Promise<void> => {
    if (!release) {
      closing = true;
      release = (async () => {
        while (accepted.size) {
          await Promise.allSettled(accepted);
        }
        params.replica.close();
        await params.transport.release();
      })();
    }
    return release;
  };
  const snapshot = (authority: SessionActorAuthority): SessionActorHotState | undefined => {
    assertReadable();
    authority.assertCurrent();
    try {
      generation?.assertCurrent();
    } catch {
      params.replica.invalidate();
      return undefined;
    }
    const installed = fenced ? undefined : params.replica.read();
    if (installed) {
      authority.authorize("commit", installed);
      authority.assertCurrent();
      assertReadable();
      if (!isInstalled(installed)) {
        return undefined;
      }
    }
    return installed;
  };
  const bind = (phase?: PhaseState): SessionActor => ({
    target,
    assertCurrent,
    assertReadable,
    snapshot,
    release: releaseActor,
    read: (authority) => read(authority, phase),
    acceptInput: (input, authority, observer) =>
      command("acceptInput", input, authority, observer, phase),
    adoptRun: (input, authority, observer) =>
      command("adoptRun", input, authority, observer, phase),
    appendToolResult: (input, authority, observer) =>
      command("appendToolResult", input, authority, observer, phase),
    appendTranscriptEvent: (input, authority, observer) =>
      command("appendTranscriptEvent", input, authority, observer, phase),
    completeTurn: (input, authority, observer) =>
      command("completeTurn", input, authority, observer, phase),
    deliveryPending: (input, authority, observer) =>
      command("deliveryPending", input, authority, observer, phase),
    deliverySettled: (input, authority, observer) =>
      command("deliverySettled", input, authority, observer, phase),
    patch: (input, authority, observer) => command("patch", input, authority, observer, phase),
    withPhase: (phaseId, authority, operation) =>
      retain(async () => {
        const held: PhaseState = {
          id: phaseId,
          active: true,
          reducers: [],
          pending: new Set(),
          uncertain: false,
        };
        const actor = bind(held);
        const failures: unknown[] = [];
        let result: { value: Awaited<ReturnType<typeof operation>> } | undefined;
        try {
          result = {
            value: await operation({
              actor,
              patch(reducers) {
                assertAccepted();
                authority.assertCurrent();
                if (!held.active) {
                  throw new Error("Session actor phase is settled");
                }
                held.reducers.push(...structuredClone(reducers));
              },
            }),
          };
        } catch (error) {
          failures.push(error);
        }
        try {
          while (held.pending.size) {
            await Promise.allSettled(held.pending);
          }
          if (held.uncertain) {
            throw new SqliteWorkerError(
              "Session actor phase has an unknown outcome; reconcile without replay",
              "outcome-unknown",
            );
          }
          while (held.reducers.length) {
            const settled = await command(
              "patch",
              {
                commandId: randomUUID(),
                phaseId,
                reducers: [],
              },
              authority,
              undefined,
              held,
            );
            if (settled.kind !== "committed") {
              throw new SqliteWorkerError(
                settled.error.message,
                settled.kind === "unknown" ? "outcome-unknown" : "unavailable",
              );
            }
          }
        } catch (error) {
          failures.push(error);
        } finally {
          held.active = false;
        }
        if (failures.length) {
          throw failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Session actor phase and flush failed");
        }
        return result!.value;
      }, phase),
  });
  return bind();
}

import { randomUUID } from "node:crypto";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorCommandContext,
  SessionActorCommitObserver,
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorPhaseInputs,
  SessionActorPhaseResults,
  SessionActorReducer,
  SessionActorTarget,
  SessionActorStorage,
} from "./session-actor-contract.js";

export type SessionActorExecutorGuards = {
  target: SessionActorTarget;
  assertAccepted(): void;
  assertReadable(): void;
};

/** A backend settles commands and publishes complete state before returning. */
export type SessionActorExecutor = {
  storage?: SessionActorStorage;
  snapshot(authority: SessionActorAuthority): SessionActorHotState | undefined;
  read(authority: SessionActorAuthority): Promise<SessionActorHotState>;
  command<Phase extends SessionActorPhase>(
    phase: Phase,
    input: SessionActorCommandContext & SessionActorPhaseInputs[Phase],
    authority: SessionActorAuthority,
    observer?: SessionActorCommitObserver<SessionActorPhaseResults[Phase]>,
  ): Promise<SessionActorOutcome<SessionActorPhaseResults[Phase]>>;
  retain?<T>(operation: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
};

type PhaseState = {
  id: string;
  active: boolean;
  reducers: SessionActorReducer[];
  pending: Set<Promise<unknown>>;
  uncertain: boolean;
};

/** Shared admission, accepted-work drainage, and phase batching for every backend. */
export function createSessionActorWithExecutor(params: {
  target: SessionActorTarget;
  lifetime: SessionActorLifetime;
  createExecutor(guards: SessionActorExecutorGuards): SessionActorExecutor;
}): SessionActor {
  const target = freezeJsonSnapshot(structuredClone(params.target));
  const accepted = new Set<Promise<unknown>>();
  let closing = false;
  let release: Promise<void> | undefined;
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
  const executor = params.createExecutor({ target, assertAccepted, assertReadable });
  const storage = executor.storage;
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
      const work = executor.retain ? executor.retain(operation) : operation();
      void work.then(retained.resolve, retained.reject);
    } catch (error) {
      retained.reject(error);
    }
    return promise;
  };
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
      const reducers = phase?.reducers.splice(0) ?? [];
      captured.reducers = [...reducers, ...(captured.reducers ?? [])];
      const outcome = await executor.command(name, captured, authority, observer);
      if (phase && outcome.kind === "unknown") {
        phase.uncertain = true;
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
        await executor.release();
      })();
    }
    return release;
  };
  const bind = (phase?: PhaseState): SessionActor => ({
    target,
    ...(storage
      ? {
          storage: {
            acquire(sessionKey, lifetime) {
              return storage.acquire(sessionKey, lifetime);
            },
            readCurrent(query, authority) {
              return storage.readCurrent(query, authority);
            },
            read(query, authority) {
              const captured = structuredClone(query);
              return retain(() => storage.read(captured, authority), phase);
            },
            mutate(mutation, authority, observer) {
              const captured = structuredClone(mutation);
              return retain(() => storage.mutate(captured, authority, observer), phase);
            },
          } satisfies SessionActorStorage,
        }
      : {}),
    assertCurrent,
    assertReadable,
    snapshot: (authority) => executor.snapshot(authority),
    release: releaseActor,
    read: (authority) => retain(() => executor.read(authority), phase),
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

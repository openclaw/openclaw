import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseAgentSessionKey, toAgentStoreSessionKey } from "../../routing/session-key.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type {
  SessionActorAuthority,
  SessionActorFactory,
  SessionActorOutcome,
  SessionActorPhaseResults,
} from "./session-actor-contract.js";
import { createSessionActorWithExecutor } from "./session-actor-executor.js";
import { createSessionActorMemoryPending } from "./session-actor-memory-pending.js";
import { validateSessionActorMemoryRecoveryInput } from "./session-actor-memory-recovery.js";
import { validateSessionActorMemorySources } from "./session-actor-memory-sources.js";
import {
  advanceSessionActorMemoryState,
  cloneSessionActorMemoryState,
  createSessionActorMemoryState,
  type SessionActorMemoryRecord,
} from "./session-actor-memory-state.js";
import { createSessionActorMemoryStorage } from "./session-actor-memory-storage.js";
import { createSessionActorMemoryTranscript } from "./session-actor-memory-transcript.js";
import {
  applySessionActorPhaseWithBackend,
  SessionActorStaleStateError,
  type SessionActorMutation,
} from "./session-actor-phase.js";
import { createSessionActorCommittedOutcome } from "./session-actor-receipt.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";

function errorFacts(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "Session actor command failed" };
}

/** Memory is authoritative until session close; it is never evicted into a database. */
export function createMemorySessionActorOwner(options: { agentId: string; path: string }) {
  const identity = Object.freeze({
    kind: "memory" as const,
    handle: randomUUID(),
    incarnation: randomUUID(),
  });
  const sessions = new Map<string, SessionActorMemoryRecord>();
  let queue = Promise.resolve();
  const enqueue = <T>(run: () => T): Promise<T> => {
    const result = queue.then(run);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Incognito session actor owner is closed");
    }
  };
  const factory: SessionActorFactory = {
    async acquire(requestedTarget, lifetime) {
      lifetime.assertAdmission?.();
      lifetime.assertCurrent();
      assertOpen();
      if (!isDeepStrictEqual(requestedTarget.database, identity)) {
        throw new Error("Incognito session actor target differs from its memory owner");
      }
      const { sessionKey } = requestedTarget;
      if (
        !isIncognitoSessionKey(sessionKey) ||
        parseAgentSessionKey(sessionKey)?.agentId !== options.agentId ||
        toAgentStoreSessionKey({ agentId: options.agentId, requestKey: sessionKey }) !== sessionKey
      ) {
        throw new Error("Memory session actors require an incognito session key");
      }
      const target = structuredClone(requestedTarget);
      let selected = sessions.get(sessionKey);
      if (!selected) {
        selected = { state: createSessionActorMemoryState(target), closed: false };
        sessions.set(sessionKey, selected);
      }
      const session = selected;
      const current = () => {
        assertOpen();
        if (session.closed) {
          throw new Error("Incognito session actor is closed");
        }
        return session.state;
      };
      return createSessionActorWithExecutor({
        target,
        lifetime,
        createExecutor(guards) {
          const snapshot = (authority: SessionActorAuthority) => {
            const hot = structuredClone(current().hot);
            authority.authorize("commit", hot);
            guards.assertReadable();
            authority.assertCurrent();
            return hot;
          };
          return {
            storage: createSessionActorMemoryStorage({
              ...options,
              target,
              sessions,
              current,
              enqueue,
              guards,
            }),
            snapshot,
            read: (authority) => enqueue(() => snapshot(authority)),
            command: (phase, input, authority, observer) =>
              enqueue(() => {
                type Value = SessionActorPhaseResults[typeof phase];
                try {
                  const before = current();
                  if (input.expected && !isDeepStrictEqual(input.expected, before.hot.version)) {
                    return {
                      kind: "stale-version",
                      expected: input.expected,
                      postimage: snapshot(authority),
                      error: {
                        name: "SessionActorStaleVersionError",
                        message: "Session actor version changed before command admission",
                      },
                    };
                  }
                  const working = cloneSessionActorMemoryState(before);
                  const admit = (stage: "transaction" | "commit", publication?: unknown) => {
                    authority.authorize(stage, structuredClone(working.hot), publication);
                  };
                  const validateSources = (sources?: SessionSourcePredicate[]) =>
                    validateSessionActorMemorySources(
                      (key) => (key === sessionKey ? working : sessions.get(key)?.state),
                      identity.incarnation,
                      sources,
                    );
                  const pending = createSessionActorMemoryPending(working, { ...options, admit });
                  const transcript = createSessionActorMemoryTranscript({
                    state: working,
                    ...options,
                    admit,
                    validateSources,
                  });
                  const command = {
                    type: `session.actor.${phase}`,
                    input: { ...input, target },
                    // SAFETY: The public actor command correlates this phase and input.
                  } as SessionActorMutation;
                  authority.authorize("transaction", structuredClone(before.hot));
                  const applied = applySessionActorPhaseWithBackend(command, working.hot, {
                    agentId: options.agentId,
                    writeEntry: (next) => {
                      working.hot.entry = next;
                    },
                    ...transcript,
                    validateSources,
                    validateRecoveryInput: (claim) =>
                      validateSessionActorMemoryRecoveryInput(working, claim),
                    mutatePendingInput: (value) => pending.mutate(value),
                    admit,
                  });
                  advanceSessionActorMemoryState(working);
                  // This is the sole effect boundary; no asynchronous work runs inside it.
                  authority.authorize("commit", structuredClone(working.hot));
                  guards.assertAccepted();
                  current();
                  authority.assertCurrent();
                  const committed = createSessionActorCommittedOutcome({
                    phase,
                    command: input,
                    before: before.hot,
                    after: working.hot,
                    applied,
                  });
                  session.state = working;
                  try {
                    observer?.committed(
                      // SAFETY: Shared phase dispatch preserves the command/result correlation.
                      structuredClone(committed) as Extract<
                        SessionActorOutcome<Value>,
                        { kind: "committed" }
                      >,
                    );
                  } catch (error) {
                    committed.failure = errorFacts(error);
                  }
                  // SAFETY: The shared phase kernel returns the result for this exact command.
                  return structuredClone(committed) as SessionActorOutcome<Value>;
                } catch (error) {
                  return {
                    kind: "rolled-back",
                    error: errorFacts(error),
                    ...(error instanceof SessionActorStaleStateError
                      ? ({ reason: "stale-state" } as const)
                      : {}),
                  };
                }
              }),
            async release() {},
          };
        },
      });
    },
  };
  return {
    identity,
    ...factory,
    closeSession(sessionKey: string) {
      const session = sessions.get(sessionKey);
      if (session) {
        session.closed = true;
      }
      sessions.delete(sessionKey);
    },
    close() {
      closed = true;
      sessions.clear();
    },
  };
}

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseAgentSessionKey, toAgentStoreSessionKey } from "../../routing/session-key.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type {
  SessionActorAuthority,
  SessionActorFactory,
  SessionActorOutcome,
  SessionActorPhaseResults,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { createSessionActorWithExecutor } from "./session-actor-executor.js";
import { createSessionActorMemoryPending } from "./session-actor-memory-pending.js";
import { validateSessionActorMemoryRecoveryInput } from "./session-actor-memory-recovery.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import { createSessionActorMemoryTranscript } from "./session-actor-memory-transcript.js";
import {
  applySessionActorPhaseWithBackend,
  SessionActorStaleStateError,
  type SessionActorMutation,
} from "./session-actor-phase.js";
import { createSessionActorCommittedOutcome } from "./session-actor-receipt.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";

function errorFacts(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "Session actor command failed" };
}

function emptyState(target: SessionActorTarget): SessionActorMemoryState {
  return {
    hot: {
      target,
      version: { epoch: randomUUID(), sequence: 0 },
      writeToken: "0",
      dependencySessionIds: [],
      entry: undefined,
      hasBoard: false,
      participants: [],
      members: [],
      pendingInputs: [],
      completionKeys: [],
      transcript: {
        watermark: { generation: null, maxSeq: null },
        version: { generation: null, rawSeq: null, updatedAt: null },
        anchorsState: "resident",
        anchors: [],
        idempotency: [],
        modelContext: { kind: "resident", entries: [] },
      },
    },
    events: [],
    pendingInputs: new Map(),
    completions: new Map(),
    goalReceipts: new Map(),
  };
}

type MemorySession = { state: SessionActorMemoryState; closed: boolean; queue: Promise<void> };

/** Memory is authoritative until session close; it is never evicted into a database. */
export function createMemorySessionActorOwner(options: { agentId: string; path: string }) {
  const identity = Object.freeze({
    kind: "memory" as const,
    handle: randomUUID(),
    incarnation: randomUUID(),
  });
  const sessions = new Map<string, MemorySession>();
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
        selected = { state: emptyState(target), closed: false, queue: Promise.resolve() };
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
      const enqueue = <T>(run: () => T): Promise<T> => {
        const result = session.queue.then(run);
        session.queue = result.then(
          () => {},
          () => {},
        );
        return result;
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
                  const working: SessionActorMemoryState = {
                    hot: structuredClone(before.hot),
                    events: [...before.events],
                    pendingInputs: new Map(before.pendingInputs),
                    completions: new Map(before.completions),
                    goalReceipts: new Map(before.goalReceipts),
                  };
                  const admit = (stage: "transaction" | "commit", publication?: unknown) => {
                    authority.authorize(stage, structuredClone(working.hot), publication);
                  };
                  const validateSources = (
                    sources?: SessionSourcePredicate[],
                  ): SessionSourceValidation => {
                    const result: SessionSourceValidation = { conversationMatches: [] };
                    for (const [index, source] of (sources ?? []).entries()) {
                      const other =
                        source.sessionKey === sessionKey
                          ? working
                          : sessions.get(source.sessionKey)?.state;
                      const entry = other?.hot.entry;
                      const members =
                        source.members && other?.hot.members.map((member) => member.identityId);
                      if (source.conversationAlternatives?.length) {
                        throw new Error("Memory session conversation bindings are not installed");
                      }
                      if (
                        source.source.databaseIdentity !== identity.incarnation ||
                        Boolean(entry) !== Boolean(source.expected) ||
                        source.fields.some(
                          (field) => !isDeepStrictEqual(entry?.[field], source.expected?.[field]),
                        ) ||
                        (source.members && !isDeepStrictEqual(members, source.members)) ||
                        (source.transcript &&
                          (source.transcript.sessionId !== entry?.sessionId ||
                            !isDeepStrictEqual(
                              source.transcript.version,
                              other?.hot.transcript.version,
                            )))
                      ) {
                        return { ...result, refusedSource: { index, facts: { entry, members } } };
                      }
                    }
                    return result;
                  };
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
                  working.hot.version = {
                    epoch: before.hot.version.epoch,
                    sequence: before.hot.version.sequence + 1,
                  };
                  working.hot.writeToken = String(working.hot.version.sequence);
                  working.hot.dependencySessionIds = working.hot.entry
                    ? [working.hot.entry.sessionId]
                    : [];
                  working.hot.pendingInputs = [...working.pendingInputs.values()].map(
                    ({ message_json: _message, ...row }) => row,
                  );
                  working.hot.completionKeys = [...working.completions.keys()];
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

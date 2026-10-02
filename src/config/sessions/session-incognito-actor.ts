import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { SqliteWorkerError, type SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type {
  AgentDatabaseIncognitoIdentity,
  AgentDatabaseIncognitoOperations,
} from "../../state/openclaw-agent-execution-contract.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionCreate,
  IncognitoSessionFacts,
  IncognitoSessionRead,
  IncognitoSessionOperations,
} from "./session-incognito-contract.js";
import type { IncognitoOutboxOperations } from "./session-incognito-outbox-contract.js";
import {
  isIncognitoSideDataWrite,
  type IncognitoSideDataOperations,
} from "./session-incognito-side-data-contract.js";
import {
  isIncognitoTranscriptWrite,
  type IncognitoTranscriptOperations,
} from "./session-incognito-transcript-contract.js";

type Scope = Pick<SqliteWorkerStore<AgentDatabaseIncognitoOperations>, "execute">;
export type IncognitoSessionRunner = <T>(
  authority: IncognitoSessionAuthority,
  operation: (scope: Scope) => Promise<T>,
  signal?: AbortSignal,
  admission?: SqliteWorkerAdmissionFactory,
) => Promise<T>;

export type IncognitoSessionClaim = {
  readonly identity: AgentDatabaseIncognitoIdentity;
  readonly sessionKey: string;
  assertCurrent(this: void): void;
};

/** Actor-local projection owned by its lifetime, never a roster or full-entry cache. */
export function createIncognitoSessionFacts(
  identity: AgentDatabaseIncognitoIdentity,
  assertActorCurrent: () => void,
  withGrant: <T>(operation: () => T) => T,
) {
  const entries = new Map<string, IncognitoSessionFacts>();
  const pending = new Set<string>();
  const unavailable = new Set<string>();
  let topologyRevision = 0;
  const current = (sessionKey: string) => {
    assertActorCurrent();
    if (pending.has(sessionKey) || unavailable.has(sessionKey)) {
      throw new Error("Incognito session facts are pending or unavailable");
    }
    return entries.get(sessionKey);
  };
  const install = (facts: IncognitoSessionFacts) => {
    assertActorCurrent();
    if (!isDeepStrictEqual(facts.identity, identity)) {
      throw new Error("Incognito publication belongs to another actor");
    }
    const previous = entries.get(facts.sessionKey);
    if (previous && previous.revision > facts.revision) {
      throw new Error("Incognito publication is older than committed facts");
    }
    const next = structuredClone(facts);
    if (previous?.sharing?.entry?.sessionId === next.sharing?.entry?.sessionId && previous) {
      next.expiresAt = previous.expiresAt;
    }
    if (
      previous?.sharing?.entry?.sessionId !== next.sharing?.entry?.sessionId ||
      previous?.sharing?.entry?.lifecycleRevision !== next.sharing?.entry?.lifecycleRevision
    ) {
      topologyRevision += 1;
    }
    // Misses belong to their scoped claim, not an ever-growing negative cache.
    if (next.sharing?.entry) {
      entries.set(next.sessionKey, next);
    } else {
      entries.delete(next.sessionKey);
    }
    unavailable.delete(facts.sessionKey);
  };
  const claim = (sessionKey: string, assertBorrowed: () => void): IncognitoSessionClaim => {
    const observed = current(sessionKey)?.sharing?.entry;
    const capturedRevision = topologyRevision;
    return {
      identity,
      sessionKey,
      assertCurrent() {
        assertBorrowed();
        const entry = current(sessionKey)?.sharing?.entry;
        if (
          entry?.sessionId !== observed?.sessionId ||
          entry?.lifecycleRevision !== observed?.lifecycleRevision ||
          (!observed && capturedRevision !== topologyRevision)
        ) {
          throw new Error("Incognito session generation is no longer current");
        }
      },
    };
  };
  return {
    clear() {
      entries.clear();
      pending.clear();
      unavailable.clear();
      topologyRevision += 1;
    },
    bind(run: IncognitoSessionRunner, assertBorrowed: () => void) {
      const perform = <Key extends keyof IncognitoSessionOperations, Result>(
        authority: IncognitoSessionAuthority,
        command: { type: Key; input: IncognitoSessionOperations[Key]["input"] },
        changing: boolean,
        receive: (value: IncognitoSessionOperations[Key]["output"]) => Result,
        signal?: AbortSignal,
      ) => {
        // Capture caller-owned input before queue waits.
        const captured = structuredClone(command);
        const targets = new Set<string>();
        let native:
          | {
              retained: RetainedWorkerTransactionAdmission;
              admission: SqliteWorkerOperationAdmission;
            }
          | undefined;
        let postimage: IncognitoSessionFacts[] | undefined;
        let commitGranted = false;
        return run(
          authority,
          async (scope) => {
            assertActorCurrent();
            let outcome:
              | { ok: true; value: IncognitoSessionOperations[Key]["output"] }
              | { ok: false; error: unknown };
            try {
              const value = await scope.execute(captured);
              outcome = { ok: true, value };
            } catch (error) {
              outcome = { ok: false, error };
            }
            try {
              if (native) {
                const settlement = await native.retained.settled;
                const receipt = native.admission.committed?.facts;
                if (receipt !== undefined) {
                  if (!postimage || !isDeepStrictEqual(receipt, postimage)) {
                    for (const key of targets) {
                      unavailable.add(key);
                    }
                    throw new SqliteWorkerError(
                      "Incognito commit receipt differs from its grant",
                      "outcome-unknown",
                    );
                  }
                  // Revocation cannot undo COMMIT. Publish while FIFO custody is still held.
                  postimage.forEach(install);
                } else if (changing && (commitGranted || outcome.ok)) {
                  for (const key of targets) {
                    unavailable.add(key);
                  }
                  throw new SqliteWorkerError(
                    "Incognito mutation has no confirmed commit receipt",
                    "outcome-unknown",
                  );
                }
                if (
                  settlement.kind !== "not-entered" &&
                  native.admission.settlement?.kind !== "completed"
                ) {
                  for (const key of targets) {
                    unavailable.add(key);
                  }
                  throw new SqliteWorkerError(
                    "Incognito session native settlement is unknown",
                    "outcome-unknown",
                  );
                }
              }
              if (!outcome.ok) {
                throw outcome.error;
              }
              if (!changing) {
                outcome.value.facts.forEach(install);
              }
              for (const key of targets) {
                pending.delete(key);
              }
              authority.assertCurrent();
              assertActorCurrent();
              return receive(outcome.value);
            } finally {
              for (const key of targets) {
                pending.delete(key);
              }
            }
          },
          signal,
          (retained) => {
            let phase: "prepare" | "transaction" | "commit" = "prepare";
            const admission = createSqliteWorkerOperationAdmission((request, grant) =>
              withGrant(() => {
                authority.assertCurrent();
                assertActorCurrent();
                signal?.throwIfAborted();
                if (
                  !isRecord(request.facts) ||
                  !isDeepStrictEqual(request.facts.identity, identity)
                ) {
                  throw new Error("Incognito session operation belongs to another actor");
                }
                if (request.stage !== "prepare") {
                  if (
                    !changing ||
                    !(
                      (phase === "prepare" && request.stage === "transaction") ||
                      (phase === "transaction" && request.stage === "commit")
                    )
                  ) {
                    throw new Error("Incognito session authority requested out of order");
                  }
                  const received = request.facts.sessions;
                  if (
                    !Array.isArray(received) ||
                    received.some(
                      (facts: unknown) =>
                        !isRecord(facts) ||
                        !isDeepStrictEqual(facts.identity, identity) ||
                        typeof facts.sessionKey !== "string" ||
                        !Number.isSafeInteger(facts.revision),
                    )
                  ) {
                    throw new Error("Incognito session grant differs from its captured target");
                  }
                  // SAFETY: the private, typed worker sends these bounded publication envelopes.
                  const facts = received as IncognitoSessionFacts[];
                  const keys = facts.map((entry) => entry.sessionKey);
                  if (
                    new Set(keys).size !== keys.length ||
                    ("sessionKey" in captured.input &&
                      (keys.length !== 1 || keys[0] !== captured.input.sessionKey)) ||
                    (request.stage === "commit" && !isDeepStrictEqual(keys, [...targets]))
                  ) {
                    throw new Error("Incognito session grant changed its target set");
                  }
                  for (const entry of facts) {
                    targets.add(entry.sessionKey);
                    pending.add(entry.sessionKey);
                  }
                  for (const entry of facts) {
                    const authorization: unknown = authority.authorize?.(
                      request.stage,
                      structuredClone(entry),
                    );
                    if (isPromiseLike(authorization)) {
                      void Promise.resolve(authorization).catch(() => undefined);
                      throw new Error("Incognito session grants must remain synchronous");
                    }
                  }
                  if (request.stage === "commit") {
                    postimage = facts;
                  }
                  phase = request.stage;
                }
                authority.assertCurrent();
                assertActorCurrent();
                signal?.throwIfAborted();
                if (!grant()) {
                  throw new Error("Incognito session authority expired");
                }
                commitGranted ||= request.stage === "commit";
              }),
            );
            native = { retained, admission };
            return { nativeLocations: [], admission };
          },
        );
      };
      return {
        read: (
          authority: IncognitoSessionAuthority,
          input: IncognitoSessionRead,
          signal?: AbortSignal,
        ) => {
          const sessionKey = input.sessionKey;
          return perform(
            authority,
            { type: "session.entry.read", input },
            false,
            (value) => ({ entry: value.entry, claim: claim(sessionKey, assertBorrowed) }),
            signal,
          );
        },
        create: (
          authority: IncognitoSessionAuthority,
          input: IncognitoSessionCreate,
          signal?: AbortSignal,
        ) => {
          const sessionKey = input.sessionKey;
          return perform(
            authority,
            { type: "session.entry.create", input },
            true,
            (value) => ({ entry: value.entry, claim: claim(sessionKey, assertBorrowed) }),
            signal,
          );
        },
        sideData: <Key extends keyof IncognitoSideDataOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoSideDataOperations[Key]["input"] },
          signal?: AbortSignal,
        ): Promise<IncognitoSideDataOperations[Key]["output"]> =>
          perform(
            authority,
            command,
            isIncognitoSideDataWrite(command.type),
            (result) => result.value,
            signal,
          ),
        transcript: <Key extends keyof IncognitoTranscriptOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoTranscriptOperations[Key]["input"] },
          signal?: AbortSignal,
        ): Promise<IncognitoTranscriptOperations[Key]["output"]> =>
          perform(
            authority,
            command,
            isIncognitoTranscriptWrite(command.type),
            (result) => result.value,
            signal,
          ),
        outbox: <Key extends keyof IncognitoOutboxOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoOutboxOperations[Key]["input"] },
          signal?: AbortSignal,
        ): Promise<IncognitoOutboxOperations[Key]["output"]> =>
          perform(authority, command, true, (result) => result.value, signal),
        captureCurrent(sessionKey: string) {
          assertBorrowed();
          return claim(sessionKey, assertBorrowed);
        },
        readSharing(sessionKey: string) {
          assertBorrowed();
          return structuredClone(current(sessionKey)?.sharing);
        },
        deadlines() {
          assertBorrowed();
          return [...entries].flatMap(([sessionKey, facts]) => {
            const entry = facts.sharing?.entry;
            return entry && facts.expiresAt !== undefined
              ? [
                  {
                    sessionKey,
                    sessionId: entry.sessionId,
                    expiresAt: facts.expiresAt,
                    source: {
                      identity: identity.incarnation,
                      assertCurrent() {
                        assertActorCurrent();
                        // Pending sharing cannot retire a lifetime. Deletion checks its session ID.
                        if (
                          entries.get(sessionKey)?.sharing?.entry?.sessionId !== entry.sessionId
                        ) {
                          throw new Error("Incognito deadline no longer owns this session");
                        }
                      },
                    },
                  },
                ]
              : [];
          });
        },
      };
    },
  };
}

import { randomUUID } from "node:crypto";
import { createDeferredCore } from "../../shared/deferred.js";
import { authorizeSessionFacts } from "./session-incognito-admission.js";
import type { IncognitoSessionOperations } from "./session-incognito-contract.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
} from "./session-incognito-facts.types.js";
import type { IncognitoHistoryOperations } from "./session-incognito-history-contract.js";

export type IncognitoSessionClaim = {
  readonly identity: IncognitoSessionFacts["identity"];
  readonly sessionKey: string;
  assertCurrent(this: void): void;
  authorize(authority: IncognitoSessionAuthority, stage: "transaction" | "commit"): void;
};

/** Claims consume the actor's live projection; they never own a second copy of its state. */
export function createIncognitoSessionClaims(owner: {
  identity: IncognitoSessionFacts["identity"];
  assertReadable(this: void): void;
  current(this: void, sessionKey: string): IncognitoSessionFacts | undefined;
  readTopologyRevision(this: void): number;
  readSnapshotRevision(this: void): number;
  hasUnsettledFacts(this: void): boolean;
  entries: ReadonlyMap<string, IncognitoSessionFacts>;
  withGrant<T>(this: void, operation: () => T): T;
}) {
  const { identity, current, readTopologyRevision, withGrant } = owner;
  const claim = (
    sessionKey: string,
    assertBorrowed: () => void,
    absent?: IncognitoSessionFacts,
  ): IncognitoSessionClaim => {
    const observed = current(sessionKey)?.sharing?.entry;
    const capturedRevision = readTopologyRevision();
    const assertCurrent = () => {
      assertBorrowed();
      const entry = current(sessionKey)?.sharing?.entry;
      if (
        entry?.sessionId !== observed?.sessionId ||
        entry?.lifecycleRevision !== observed?.lifecycleRevision ||
        (!observed && capturedRevision !== readTopologyRevision())
      ) {
        throw new Error("Incognito session generation is no longer current");
      }
    };
    return {
      identity,
      sessionKey,
      assertCurrent,
      authorize(authority, stage) {
        withGrant(() => {
          authority.assertCurrent();
          assertCurrent();
          const facts = current(sessionKey) ?? (!observed ? absent : undefined);
          if (!facts) {
            throw new Error("Incognito session facts are unavailable");
          }
          authorizeSessionFacts(authority, stage, facts);
          authority.assertCurrent();
          assertCurrent();
        });
      },
    };
  };
  return {
    claim,
    captureStoreSnapshot(
      this: void,
      assertBorrowed: () => void,
      authority: IncognitoSessionAuthority,
    ) {
      const observed = owner.readSnapshotRevision();
      return {
        assertCurrent(this: void) {
          assertBorrowed();
          authority.assertCurrent();
          if (owner.readSnapshotRevision() !== observed || owner.hasUnsettledFacts()) {
            throw new Error("Incognito session snapshot changed; prepare it again");
          }
        },
      };
    },
    captureRead(this: void, assertReadable: () => void) {
      return {
        captureCurrent(this: void, sessionKey: string) {
          assertReadable();
          return claim(sessionKey, assertReadable);
        },
        readSharing(this: void, sessionKey: string) {
          assertReadable();
          return structuredClone(current(sessionKey)?.sharing);
        },
        readChatMetadataRevision(this: void, sessionKey: string) {
          assertReadable();
          return current(sessionKey)?.chatMetadataRevision;
        },
        readEntryRevision(this: void, sessionKey: string) {
          assertReadable();
          return current(sessionKey)?.entryReadRevision;
        },
        readDelivery(this: void, sessionKey: string) {
          assertReadable();
          return structuredClone(current(sessionKey)?.delivery);
        },
        readMedia(this: void, sessionKey: string) {
          assertReadable();
          return structuredClone(current(sessionKey)?.media);
        },
        readSteering(this: void, sessionKey: string) {
          assertReadable();
          return structuredClone(current(sessionKey)?.steering);
        },
        readPolicy(this: void, sessionKey: string) {
          assertReadable();
          return structuredClone(current(sessionKey)?.policy);
        },
        readCliHistory(this: void, sessionKey: string) {
          assertReadable();
          return structuredClone(current(sessionKey)?.cliHistory);
        },
        readCapability(this: void, sessionKey: string) {
          assertReadable();
          return structuredClone(current(sessionKey)?.capability);
        },
      };
    },
    deadlines(this: void, assertBorrowed: () => void, assertAdmittedCurrent: () => void) {
      assertBorrowed();
      return [...owner.entries].flatMap(([sessionKey, facts]) => {
        const entry = facts.sharing?.entry;
        return entry && facts.expiresAt !== undefined
          ? [
              {
                sessionKey,
                sessionId: entry.sessionId,
                expiresAt: facts.expiresAt,
                source: {
                  identity: identity.incarnation,
                  assertSettlingCurrent(this: void) {
                    assertBorrowed();
                    const currentId = owner.entries.get(sessionKey)?.sharing?.entry?.sessionId;
                    if (currentId !== undefined && currentId !== entry.sessionId) {
                      throw new Error("Incognito deadline no longer owns this session");
                    }
                  },
                  assertCurrent(this: void) {
                    assertAdmittedCurrent();
                    // Pending sharing cannot retire a lifetime. Deletion checks its session ID.
                    const stored = owner.entries.get(sessionKey);
                    if (stored?.sharing?.entry?.sessionId !== entry.sessionId) {
                      throw new Error("Incognito deadline no longer owns this session");
                    }
                  },
                },
              },
            ]
          : [];
      });
    },
    captureSnapshot(this: void, sessionKey: string, assertBorrowed: () => void) {
      assertBorrowed();
      const observed = current(sessionKey)?.revision;
      const held = claim(sessionKey, assertBorrowed);
      const settled = claim(sessionKey, owner.assertReadable);
      const assertRevision = () => {
        if (current(sessionKey)?.revision !== observed) {
          throw new Error("Incognito session snapshot changed; prepare it again");
        }
      };
      return {
        assertCurrent(this: void) {
          held.assertCurrent();
          assertRevision();
        },
        /** Validate consumed facts after borrow cleanup; this grants no further reads. */
        assertSettledCurrent(this: void) {
          settled.assertCurrent();
          assertRevision();
        },
      };
    },
  };
}

/** Borrow authority remains live at every command grant; cleanup uses its settlement authority. */
export function retainIncognitoSessionAuthority(
  assertAuthority: () => void,
  request: IncognitoSessionAuthority,
): IncognitoSessionAuthority {
  return {
    entryCreation: request.entryCreation,
    assertCurrent() {
      assertAuthority();
      request.assertCurrent();
    },
    authorize: (stage, facts) => request.authorize?.(stage, facts),
  };
}

/** Grant-local facts never escape their command's synchronous authority callback. */
export function createIncognitoSessionGrants(withGrant: <T>(operation: () => T) => T) {
  type CreationGrant = {
    facts: IncognitoSessionFacts;
    operation: NonNullable<IncognitoSessionAuthority["entryCreation"]>;
  };
  let creation: CreationGrant | undefined;
  let preimage: readonly IncognitoSessionFacts[] | undefined;
  let sourceFacts: readonly IncognitoSessionFacts[] | undefined;
  return {
    command(type: string, entryCreation: IncognitoSessionAuthority["entryCreation"]) {
      let commandCreation: CreationGrant | undefined;
      let commandPreimage: readonly IncognitoSessionFacts[] | undefined;
      return {
        run<T>(operation: () => T): T {
          return withGrant(() => {
            const previousCreation = creation;
            const previousPreimage = preimage;
            const previousSources = sourceFacts;
            creation = commandCreation;
            preimage = commandPreimage;
            sourceFacts = commandPreimage;
            try {
              return operation();
            } finally {
              creation = previousCreation;
              preimage = previousPreimage;
              sourceFacts = previousSources;
            }
          });
        },
        capture(stage: string, facts: IncognitoSessionFacts[]) {
          if (
            type === "session.entry.creation.commit" &&
            stage === "transaction" &&
            entryCreation &&
            facts[0]
          ) {
            commandCreation = { facts: facts[0], operation: entryCreation };
            creation = commandCreation;
          }
          if (stage !== "commit") {
            // Ordinary source guards retain their own mutation's transaction preimage.
            commandPreimage = facts;
            preimage = facts;
          }
          // Exact completion predicates inspect the current transaction/precommit state.
          sourceFacts = facts;
        },
      };
    },
    readPreimage(sessionKey: string) {
      return preimage?.find((facts) => facts.sessionKey === sessionKey);
    },
    readSource(sessionKey: string) {
      return sourceFacts?.find((facts) => facts.sessionKey === sessionKey);
    },
    readCreation(
      sessionKey: string,
      operation: NonNullable<IncognitoSessionAuthority["entryCreation"]>,
    ) {
      return creation?.facts.sessionKey === sessionKey && creation.operation === operation
        ? structuredClone(creation.facts)
        : undefined;
    },
  };
}

/** Store-wide reads share FIFO acceptance and one retained snapshot fence. */
export function bindIncognitoSessionStoreReads(
  read: <Key extends "session.entries.read" | "session.identities.read" | "session.entry.readById">(
    authority: IncognitoSessionAuthority,
    command: { type: Key; input: IncognitoSessionOperations[Key]["input"] },
    signal?: AbortSignal,
  ) => Promise<
    IncognitoSessionOperations[Key]["output"] & { snapshot: { assertCurrent(this: void): void } }
  >,
) {
  return {
    readById(
      authority: IncognitoSessionAuthority,
      input: IncognitoSessionOperations["session.entry.readById"]["input"],
      signal?: AbortSignal,
    ) {
      return read(authority, { type: "session.entry.readById", input }, signal);
    },
    readIdentities(
      authority: IncognitoSessionAuthority,
      input: IncognitoSessionOperations["session.identities.read"]["input"],
    ) {
      return read(authority, { type: "session.identities.read", input });
    },
    list(
      authority: IncognitoSessionAuthority,
      input: IncognitoSessionOperations["session.entries.read"]["input"],
      signal?: AbortSignal,
    ) {
      return read(authority, { type: "session.entries.read", input }, signal);
    },
  };
}

/** History reads and retained completion fences share the actor's FIFO publication owner. */
export function bindIncognitoSessionHistory(owner: {
  assertOutsideGrant(): void;
  assertBorrowed(): void;
  assertActorCurrent(): void;
  current(sessionKey: string): IncognitoSessionFacts | undefined;
  retain<T>(operation: () => Promise<T>): Promise<T>;
  execute<Key extends keyof IncognitoHistoryOperations>(
    authority: IncognitoSessionAuthority,
    command: { type: Key; input: IncognitoHistoryOperations[Key]["input"] },
    signal?: AbortSignal,
    cleanup?: boolean,
    onRead?: (value: IncognitoHistoryOperations[Key]["output"]) => void,
  ): Promise<IncognitoHistoryOperations[Key]["output"]>;
}) {
  return {
    retainCompletionSource(
      authority: IncognitoSessionAuthority,
      target: Omit<
        IncognitoHistoryOperations["session.history.completion-source.open"]["input"],
        "sourceId"
      >,
      signal?: AbortSignal,
    ): Promise<{ assertCurrent(): void; release(): Promise<void> }> {
      owner.assertOutsideGrant();
      owner.assertBorrowed();
      const input = { ...structuredClone(target), sourceId: randomUUID() };
      const done = createDeferredCore();
      const ready = createDeferredCore<{
        assertCurrent(): void;
        release(): Promise<void>;
      }>();
      let active = true;
      const work = owner.retain(async () => {
        try {
          await owner.execute(
            authority,
            { type: "session.history.completion-source.open", input },
            signal,
          );
          const assertCurrent = () => {
            authority.assertCurrent();
            owner.assertBorrowed();
            const facts = owner.current(input.sessionKey);
            if (
              !active ||
              !facts?.completionSources?.some(
                (source) => source.sourceId === input.sourceId && source.valid,
              )
            ) {
              throw new Error("Incognito harness completion source is no longer current");
            }
          };
          assertCurrent();
          ready.resolve({
            assertCurrent,
            release() {
              active = false;
              done.resolve();
              return work;
            },
          });
          await done.promise;
        } finally {
          active = false;
          await owner.execute(
            { assertCurrent: () => owner.assertActorCurrent() },
            { type: "session.history.completion-source.release", input },
            undefined,
            true,
          );
        }
      });
      void work.catch(ready.reject);
      return ready.promise;
    },

    history: <Key extends keyof IncognitoHistoryOperations>(
      authority: IncognitoSessionAuthority,
      command: { type: Key; input: IncognitoHistoryOperations[Key]["input"] },
      signal?: AbortSignal,
      onRead?: (value: IncognitoHistoryOperations[Key]["output"]) => void,
    ): Promise<IncognitoHistoryOperations[Key]["output"]> =>
      owner.execute(authority, command, signal, false, onRead),
  };
}

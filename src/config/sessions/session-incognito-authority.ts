import { authorizeSessionFacts } from "./session-incognito-admission.js";
import type { IncognitoSessionOperations } from "./session-incognito-contract.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
} from "./session-incognito-facts.types.js";

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

/** A creation's transaction preimage is visible only inside that exact live command's grant. */
export function createIncognitoSessionCreationGrants(withGrant: <T>(operation: () => T) => T) {
  type Grant = {
    facts: IncognitoSessionFacts;
    operation: NonNullable<IncognitoSessionAuthority["entryCreation"]>;
  };
  let current: Grant | undefined;
  return {
    run<T>(grant: Grant | undefined, operation: () => T): T {
      return withGrant(() => {
        const previous = current;
        current = grant;
        try {
          return operation();
        } finally {
          current = previous;
        }
      });
    },
    capture(
      type: string,
      stage: string,
      facts: IncognitoSessionFacts[],
      operation: IncognitoSessionAuthority["entryCreation"],
    ) {
      if (
        type === "session.entry.creation.commit" &&
        stage === "transaction" &&
        operation &&
        facts[0]
      ) {
        current = { facts: facts[0], operation };
        return current;
      }
      return undefined;
    },
    read(sessionKey: string, operation: NonNullable<IncognitoSessionAuthority["entryCreation"]>) {
      return current?.facts.sessionKey === sessionKey && current.operation === operation
        ? structuredClone(current.facts)
        : undefined;
    },
  };
}

/** Store-wide reads share FIFO acceptance and one retained snapshot fence. */
export function bindIncognitoSessionStoreReads(
  read: <Key extends "session.entries.read" | "session.identities.read">(
    authority: IncognitoSessionAuthority,
    command: { type: Key; input: IncognitoSessionOperations[Key]["input"] },
    signal?: AbortSignal,
  ) => Promise<
    IncognitoSessionOperations[Key]["output"] & { snapshot: { assertCurrent(this: void): void } }
  >,
) {
  return {
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

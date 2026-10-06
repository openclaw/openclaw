import { authorizeSessionFacts } from "./session-incognito-admission.js";
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
  current(this: void, sessionKey: string): IncognitoSessionFacts | undefined;
  readTopologyRevision(this: void): number;
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
    captureSnapshot(this: void, sessionKey: string, assertBorrowed: () => void) {
      assertBorrowed();
      const observed = current(sessionKey)?.revision;
      const held = claim(sessionKey, assertBorrowed);
      return {
        assertCurrent(this: void) {
          held.assertCurrent();
          if (current(sessionKey)?.revision !== observed) {
            throw new Error("Incognito session snapshot changed; prepare it again");
          }
        },
      };
    },
  };
}

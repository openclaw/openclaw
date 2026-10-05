import type { SqliteWorkerEphemeralTarget } from "../../infra/sqlite-worker-contract.js";
import type { CommittedSessionSharingFacts } from "./session-accessor.sqlite-sharing-acquisition.js";

/** Content-free postimage; full entries remain owned by the requesting read. */
export type IncognitoSessionFacts = {
  identity: Readonly<SqliteWorkerEphemeralTarget>;
  sessionKey: string;
  revision: number;
  sharing: CommittedSessionSharingFacts | undefined;
  expiresAt?: number;
};

export type IncognitoSessionAuthority = {
  assertCurrent(): void;
  /** Synchronous host policy only. Never query the actor from a native grant. */
  authorize?(stage: "transaction" | "commit", facts: IncognitoSessionFacts): void;
};

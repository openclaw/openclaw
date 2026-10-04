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

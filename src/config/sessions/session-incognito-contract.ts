import type { SqliteWorkerEphemeralTarget } from "../../infra/sqlite-worker-contract.js";
import type { CommittedSessionSharingFacts } from "./session-accessor.sqlite-sharing-acquisition.js";
import type { IncognitoComputeOperations } from "./session-incognito-compute-contract.js";
import type { IncognitoHistoryOperations } from "./session-incognito-history-contract.js";
import type { IncognitoLifecycleOperations } from "./session-incognito-lifecycle-contract.js";
import type { IncognitoOutboxOperations } from "./session-incognito-outbox-contract.js";
import type { IncognitoPendingInputOperations } from "./session-incognito-pending-input-contract.js";
import type { IncognitoSideDataOperations } from "./session-incognito-side-data-contract.js";
import type { IncognitoTranscriptOperations } from "./session-incognito-transcript-contract.js";
import type { SessionEntry } from "./types.js";

type IncognitoSessionVersion = Pick<SessionEntry, "sessionId" | "lifecycleRevision">;

/** Content-free postimage; full entries remain owned by the requesting read. */
export type IncognitoSessionFacts = {
  identity: Readonly<SqliteWorkerEphemeralTarget>;
  sessionKey: string;
  revision: number;
  sharing: CommittedSessionSharingFacts | undefined;
  expiresAt?: number;
};

export type IncognitoSessionSnapshot = {
  entry: SessionEntry | undefined;
  facts: IncognitoSessionFacts[];
};

export type IncognitoSessionRead = {
  sessionKey: string;
  expected?: IncognitoSessionVersion;
};

export type IncognitoSessionCreate = {
  sessionKey: string;
  entry: SessionEntry;
  cwd?: string;
};

type DomainOperations = IncognitoSideDataOperations &
  IncognitoComputeOperations &
  IncognitoHistoryOperations &
  IncognitoLifecycleOperations &
  IncognitoPendingInputOperations &
  IncognitoTranscriptOperations &
  IncognitoOutboxOperations;

export type IncognitoSessionOperations = {
  [Key in keyof DomainOperations]: {
    input: DomainOperations[Key]["input"];
    output: { value: DomainOperations[Key]["output"]; facts: IncognitoSessionFacts[] };
  };
} & {
  "session.entry.read": { input: IncognitoSessionRead; output: IncognitoSessionSnapshot };
  "session.entry.create": { input: IncognitoSessionCreate; output: IncognitoSessionSnapshot };
};

export type IncognitoSessionAuthority = {
  assertCurrent(): void;
  /** Synchronous host policy only. Never query the actor from a native grant. */
  authorize?(stage: "transaction" | "commit", facts: IncognitoSessionFacts): void;
};

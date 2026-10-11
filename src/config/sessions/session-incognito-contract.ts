import type { SessionEntryListScope, SessionEntrySummary } from "./session-accessor.types.js";
import type {
  SessionIdentityEvidenceIdentity,
  SessionIdentityEvidenceResult,
} from "./session-entry-read-source.types.js";
import type { IncognitoComputeOperations } from "./session-incognito-compute-contract.js";
import type { IncognitoEntryCreationOperations } from "./session-incognito-entry-creation-contract.js";
import type { IncognitoEntryPatchOperations } from "./session-incognito-entry-patch-contract.js";
import type { IncognitoSessionFacts } from "./session-incognito-facts.types.js";
import type { IncognitoHistoryOperations } from "./session-incognito-history-contract.js";
import type { IncognitoLifecycleOperations } from "./session-incognito-lifecycle-contract.js";
import type { IncognitoOutboxOperations } from "./session-incognito-outbox-contract.js";
import type { IncognitoPendingInputOperations } from "./session-incognito-pending-input-contract.js";
import type { IncognitoSideDataOperations } from "./session-incognito-side-data-contract.js";
import type { IncognitoTranscriptOperations } from "./session-incognito-transcript-contract.js";
import type { IncognitoSessionTurnOperations } from "./session-turn.types.js";
import type { SessionEntry } from "./types.js";

export type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
} from "./session-incognito-facts.types.js";

type IncognitoSessionVersion = Pick<SessionEntry, "sessionId" | "lifecycleRevision">;

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

type DomainOperations = IncognitoSessionTurnOperations &
  IncognitoEntryCreationOperations &
  IncognitoEntryPatchOperations &
  IncognitoSideDataOperations &
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
  "session.identities.read": {
    input: { identities: readonly SessionIdentityEvidenceIdentity[] };
    output: { evidence: SessionIdentityEvidenceResult[]; facts: IncognitoSessionFacts[] };
  };
  "session.entries.read": {
    input: Pick<SessionEntryListScope, "projection">;
    output: { entries: SessionEntrySummary[]; facts: IncognitoSessionFacts[] };
  };
  "session.entry.readById": {
    input: { sessionId: string; orderBy?: "updatedAt" };
    output: { selected: SessionEntrySummary | undefined; facts: IncognitoSessionFacts[] };
  };
  "session.entry.read": { input: IncognitoSessionRead; output: IncognitoSessionSnapshot };
  "session.entry.create": { input: IncognitoSessionCreate; output: IncognitoSessionSnapshot };
};

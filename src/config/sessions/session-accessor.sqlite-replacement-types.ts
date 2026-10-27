import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { ResolvedSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type {
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type {
  SessionEntryCommitContext,
  SessionEntryReplacement,
  TranscriptEvent,
} from "./session-accessor.types.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionEntryReplacement = SessionEntryReplacement & {
  previousSessionKeys?: readonly string[];
};

export type SessionEntryReplacementCommit = {
  sources?: SessionSourcePredicate[];
  nativeBindings?: SessionNativeBindingParticipants;
  expectedRows: Map<string, ResolvedSessionEntryRow>;
  labelOwnerKeys: string[];
  includeLabelOwners?: string;
  labelClaim?: { sessionKey: string; label: string };
  preparedTranscript?: {
    sessionKey: string;
    sessionId: string;
    events: readonly TranscriptEvent[];
  };
  validationKeys: string[];
  replacements: SqliteSessionEntryReplacement[];
  checkPendingArchiveRecovery?: boolean;
  consumePendingReset?: boolean;
  maintenance?: SessionEntryMaintenanceInput;
  ownerAssignment?: { sessionKey: string; owner: SessionOwnerAssignment };
};

export type SessionEntryReplacementCommitted = {
  pendingArchiveRecovery: boolean;
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
  maintenancePlans: SessionEntryMaintenancePlan[];
  membershipInvalidatedKeys: string[];
};

export type SessionEntryReplacementCandidate = {
  kind: "session-entry-replacements";
  result: Pick<SessionEntryReplacementCommitted, "maintenancePlans">;
  publication: SessionEntryReplacementPublication;
};

export type SessionEntryWorkerLifecycle<T = unknown> = {
  identityAgentId: string;
  onResult?: (value: T | undefined) => void;
  beforeCommit?: (
    publication: SessionEntryReplacementPublication,
    operation: RetainedWorkerTransactionAdmission,
  ) => void;
  afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
  onLifecycleCommitted?: (pendingArchiveRecovery: boolean) => void;
};

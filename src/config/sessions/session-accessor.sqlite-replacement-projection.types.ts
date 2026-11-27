import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import type {
  SessionEntryReplacementCommit,
  SessionEntryWorkerLifecycle,
} from "./session-accessor.sqlite-replacement-types.js";
import type {
  SessionEntryCommitContext,
  SessionEntryCreateWithTranscriptOptions,
  SessionEntryReplacementSnapshot,
} from "./session-accessor.types.js";

// Kept apart from the shared replacement types: only the projection owner needs the execution contract.
export type ReplacementProjectionOptions = {
  includeArchiveUndoMarkers?: boolean;
  memberSourceRoleImport?: SessionEntryReplacementCommit["memberSourceRoleImport"];
  creationOperation?: SessionEntryReplacementCommit["creationOperation"];
  fieldPatch?: SessionEntryReplacementCommit["fieldPatch"];
  onCommittedEntries?: SessionEntryWorkerLifecycle["onCommittedEntries"];
  retainedExecution?: OpenClawAgentDatabaseExecution;
  followRegistration?: SessionEntryCreateWithTranscriptOptions["followRegistration"];
  assertCommitAllowed?: () => void;
  withCommit?: SessionEntryCreateWithTranscriptOptions["withCommit"];
  ownerAssignment?: SessionEntryReplacementCommit["ownerAssignment"];
  labelClaim?: SessionEntryReplacementCommit["labelClaim"];
  preparedTranscript?: SessionEntryReplacementCommit["preparedTranscript"];
  checkPendingArchiveRecovery?: boolean;
  onLifecycleCommitted?: (pendingArchiveRecovery: boolean) => void;
  env?: NodeJS.ProcessEnv;
  activeSessionKey?: string;
  agentId?: string;
  consumePendingReset?: boolean;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  includeSessionWindowOwner?: string;
  includeLabelOwners?: string;
  skipMaintenance?: boolean;
  storePath: string;
};

export type ReplacementProjectionParams<T, TReplacement> = ReplacementProjectionOptions & {
  afterCommitted?: (result: T, context: SessionEntryCommitContext) => Promise<void>;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) =>
    | Promise<{ result: T; replacements?: Iterable<TReplacement> }>
    | { result: T; replacements?: Iterable<TReplacement> };
};

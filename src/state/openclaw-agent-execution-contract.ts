import type { SessionProviderReviewComparison } from "../config/sessions/provider-review.types.js";
import type {
  TranscriptArchivePublishPlan,
  TranscriptArchivePublishResult,
} from "../config/sessions/session-accessor.sqlite-archive-types.js";
import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type {
  SessionEntryReplacementCommit,
  SessionEntryReplacementCommitted,
} from "../config/sessions/session-accessor.sqlite-replacement-types.js";
import type {
  PublishedSessionTranscriptArchive,
  SessionLegacyArchiveRemovalResult,
} from "../config/sessions/session-history-archive-pruning.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { SqliteTrajectoryRuntimeAppend } from "../trajectory/runtime-store.sqlite.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-registry-listing.js";
import type { AgentDatabaseDomainOperations } from "./openclaw-agent-execution-domain.js";

/** Recorded by the native owner; a descriptor never grants access to that owner. */
export type AgentDatabaseExecutionIdentity = {
  kind: "file";
  physicalIdentity: string;
  birthtime?: string;
  incarnation: string;
  nativeLocation: string;
};

export type AgentDatabaseExecutionFileIdentity = Pick<
  AgentDatabaseExecutionIdentity,
  "kind" | "physicalIdentity" | "birthtime" | "nativeLocation"
>;

export type AgentDatabaseExecutionOpen = {
  leaseId: string;
  agentId: string;
  databasePath: string;
  stateDatabasePath: string;
  environment: SqliteWorkerStateContext["environment"];
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
  /** Captured before a creating request yields; absence is an identity too. */
  creatingIdentity?: DatabasePathIdentity;
};

export type AgentDatabaseOperations = AgentDatabaseDomainOperations & {
  "trajectory.events.append": { input: SqliteTrajectoryRuntimeAppend; output: void };
  "session.archives.preparePublication": {
    input: {
      archiveDirectory: string;
      requested: readonly Pick<TranscriptArchivePublishPlan, "sessionId" | "generation">[];
    };
    output: TranscriptArchivePublishPlan[];
  };
  "session.archives.recordPublication": {
    input: { results: readonly TranscriptArchivePublishResult[]; nowMs: number };
    output: void;
  };
  "session.transcript.initialize": {
    input: { sessionKey: string; sessionId: string; cwd?: string };
    output: SessionTranscriptInitializationPublication;
  };
  "database.prepareWrite": { input: undefined; output: void };
  "session.entry.read": { input: { sessionKey: string }; output: SessionEntry | undefined };
  "session.entries.replace": {
    input: SessionEntryReplacementCommit;
    output: SessionEntryReplacementCommitted;
  };
  "session.providerReview.compare": {
    input: SessionProviderReviewComparison;
    output: SessionEntry;
  };
  "session.archivePruning.deletePublished": {
    input: PublishedSessionTranscriptArchive;
    output: void;
  };
  "session.archivePruning.removeLegacy": {
    input: { filePath: string };
    output: SessionLegacyArchiveRemovalResult;
  };
  "session.archivePruning.reclaimPages": {
    input: { maxPages?: number };
    output: SqliteWalReclamationResult;
  };
};

/** A request owner composes its retained admission with the native owner's validation. */
export type AgentDatabaseRequestExecutionSource = {
  assertCurrent(): void;
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void;
  createAdmission(params: {
    attachment: { kind: "agent-execution"; startupJournal: boolean };
    nativeLocations: readonly string[];
    authorize(request: SqliteWorkerAdmissionRequest): void;
    assertCurrent(): void;
  }): SqliteWorkerAdmissionFactory;
};

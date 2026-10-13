import type { OpenClawConfig } from "../types.openclaw.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive-types.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";

export type SessionAgentPurgeSelection = {
  cfg: OpenClawConfig;
  agentId: string;
  storeAgentId: string;
  archiveDirectory: string;
};

export type SessionAgentPurgePlan = {
  deletePlans: SessionStateDeletePlan[];
  entryRemovals: SessionEntryRemovalPlan[];
};

export type SessionAgentPurgeCommit = SessionAgentPurgeSelection & {
  entryRemovals: SessionEntryRemovalPlan[];
  materializedPlans: MaterializedSessionStateDeletePlan[];
  maintenance: SessionEntryMaintenanceInput;
  nativeBindings?: SessionNativeBindingParticipants;
};

export type SessionAgentPurgeResult = {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  maintenancePlans: SessionEntryMaintenancePlan[];
};

export type SessionAgentPurgeCommitted = {
  kind: "session-agent-purge";
  result: SessionAgentPurgeResult;
  publication: SessionEntryReplacementPublication;
};

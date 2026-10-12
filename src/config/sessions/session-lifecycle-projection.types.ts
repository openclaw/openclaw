import type { SubagentRunsDurableBasis } from "../../agents/subagents/registry/subagent-registry-read.types.js";
import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  ProjectedLifecycleCommitInput,
  ProjectedLifecycleCommitResult,
} from "./session-accessor.sqlite-lifecycle-types.js";

export type SessionLifecycleProjectionCommit = ProjectedLifecycleCommitInput & {
  agentId: string;
  removalPlans: MaterializedSessionStateDeletePlan[];
  descendantRunBasis?: SubagentRunsDurableBasis;
};

export type SessionLifecycleProjectionCommitted = {
  kind: "session-lifecycle-projection";
  result: ProjectedLifecycleCommitResult;
  progressCardResetKeys: string[];
  projectionReconcileSessionIds: string[];
  publication: SessionEntryReplacementPublication;
};

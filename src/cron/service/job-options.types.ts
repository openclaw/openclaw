import type { SessionEntryCurrentCheck } from "../../config/sessions/session-entry-current.types.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import type { CronRuntimeAuthority } from "../runtime-authority.js";
import type { CronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import type { CronStreamExecApproval, CronStreamExecPolicy } from "../stream-exec-authority.js";
import type {
  CronJob,
  CronStoredJob,
  CronToolsAllowExecTarget,
  CronToolsAllowProvenance,
} from "../types.js";

/** Caller-specific declaration-key visibility and explicit enablement metadata. */
export type CronAddOptions = {
  /** Validated host invocation facts; immutable after fresh command-job creation. */
  pluginCommand?: CronStoredJob["pluginCommand"];
  /** Captured source digest of the admitting plugin instance; enables restart continuity. */
  pluginCommandSourceDigest?: string;
  operatorSource?: NonNullable<CronStoredJob["operatorSource"]>["source"];
  operatorSourceExecutionRevision?: string;
  inferenceBinding?: CronStoredJob["inferenceBinding"];
  /** Exact creator incarnation captured with the public owner key. */
  ownerSessionId?: string;
  payloadSourceConversation?: CronStoredJob["payloadSourceConversation"];
  sourceConversation?: CronStoredJob["sourceConversation"];
  /** Logical sandbox target captured from the admitted creator, never public input. */
  streamSandbox?: CronStoredJob["streamSandbox"];
  /** Selected revisions captured from a validated caller session, never public input. */
  skillLibrarySelections?: CronStoredJob["skillLibrarySelections"];
  matchesExisting?: (job: CronJob) => boolean;
  enabledExplicit?: boolean;
  /** Reserved declaration namespaces require trusted ownership at creation. */
  systemOwned?: boolean;
  /** Trusted creator provenance persisted with new jobs; never accepted from public input. */
  createdActor?: SessionCreatedActor;
  /** Authenticated caller provenance stamped by the service, never public input. */
  scheduledToolPolicy?: CronScheduledToolPolicy;
  /** Private proof from an authenticated agent-runtime caller. */
  toolsAllowProvenance?: CronToolsAllowProvenance;
  /** Restrict-only exec pin from the signed creator-turn identity. */
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
  /** Synchronous Gateway-owned liveness check repeated at mutation admission and commit. */
  commitGuard?: () => void;
  /** Prepared caller policy; host floors use the committing transaction's approvals. */
  execPolicy?: CronStreamExecPolicy;
  streamExecApproval?: CronStreamExecApproval;
  /** Creator-session facts refreshed by the worker at each native admission. */
  sessionEntryCurrent?: SessionEntryCurrentCheck;
  /** One-use fresh capture; callback presence means fresh even when it returns undefined. */
  captureRuntimeAuthority?: () => CronRuntimeAuthority | undefined;
};

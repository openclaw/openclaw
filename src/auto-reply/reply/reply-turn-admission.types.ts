import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { ReplyOperation, ReplyTurnKind } from "./reply-run-registry.js";

export type ReplyTurnAdmission =
  | {
      status: "owned";
      operation: ReplyOperation;
      sessionEntry?: SessionEntry;
      databaseClaim?: SessionAdmissionDatabaseClaim;
    }
  | {
      status: "skipped";
      reason: "active-run" | "aborted" | "lifecycle-invalidated";
      activeOperation?: ReplyOperation;
      sessionEntry?: SessionEntry;
      lifecycleAdmission?: SessionWorkAdmissionLease;
    };

export type ReplyTurnAdmissionParams = {
  assertRequestCurrent?: () => void;
  providerReviewAcknowledgment?: import("../../sessions/provider-review.js").ProviderReviewAcknowledgment;
  agentId?: string;
  sessionKey: string;
  sessionId: string;
  expectedSessionId?: string;
  /** Observed predecessors, from oldest to newest. */
  expectedActiveOperations?: readonly ReplyOperation[];
  storePath?: string;
  kind: ReplyTurnKind;
  resetTriggered: boolean;
  allowRestartTombstoneParentFork?: boolean;
  allowRestartTombstoneReset?: boolean;
  routeThreadId?: string | number;
  originatingLeafEntryId?: string | null;
  /**
   * Move this already-held operation into sessionKey's run slot instead of
   * creating a new one. Used when a native command turn (admitted under its
   * slash source key) continues into a full agent turn on the target session.
   */
  adoptOperation?: ReplyOperation;
  upstreamAbortSignal?: AbortSignal;
  resolveGatewayContext?: GatewayContextResolver;
  waitTimeoutMs?: number;
  waitForActive?: boolean;
  retainLifecycleAdmissionOnActive?: boolean;
  onLifecycleInterrupt?: () => void;
};

import type { BoundedConversation } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { BeforeCompactionHookMetrics } from "../../agents/embedded-agent-runner/compaction-hook-metrics.types.js";
import type {
  PreparedCompactionPlan,
  PreparedCompactionPlanOptions,
} from "../../agents/embedded-agent-runner/prepared-compaction-plan.types.js";
import type { PreparedCompactionReplayOptions } from "../../agents/embedded-agent-runner/replay-history.types.js";
import type { SessionHeader } from "../../agents/sessions/session-manager-types.js";
import type { CacheTtlProjectionPrefix } from "./session-accessor.sqlite-contract.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { SessionTranscriptHydrationWorkerInput } from "./session-transcript-hydration.types.js";

export type SessionPreparedCompactionInput = Omit<
  SessionTranscriptHydrationWorkerInput,
  | "kind"
  | "limits"
  | "transcript"
  | "preparedEntry"
  | "afterSeq"
  | "includeEventJson"
  | "compaction"
> & {
  kind: "compaction-preparation";
  operation:
    | {
        kind: "plan";
        options: PreparedCompactionPlanOptions;
        replay: PreparedCompactionReplayOptions;
      }
    | {
        kind: "render";
        entries: PreparedCompactionPlan["selections"]["history"];
        version: SessionTranscriptContextVersion;
        maxChars: number;
      };
};

export type SessionPreparedCompactionValue = {
  kind: "compaction-preparation";
} & SessionPreparedCompactionBody;

export type SessionPreparedCompactionBody =
  | { status: "rendered"; conversation: BoundedConversation }
  | { status: "unsupported"; reason: string }
  | {
      status: "skipped";
      reason: string;
      beforeHookMetrics: BeforeCompactionHookMetrics;
    }
  | {
      status: "prepared";
      plan: PreparedCompactionPlan;
      header: SessionHeader;
      version: SessionTranscriptContextVersion;
      leafEntryId: string | null;
      cacheTtlProjectionPrefixes?: CacheTtlProjectionPrefix[];
      boundaryCount: number;
      persistedSuffixStartSeq: number;
      transcriptMutationAt: number | null;
      beforeHookMetrics: BeforeCompactionHookMetrics;
      hasRealConversation: boolean;
    };

/** Required retained context uses the canonical chunk channel, not the plan-fact budget. */
export type SessionPreparedCompactionWireValue =
  | Exclude<SessionPreparedCompactionValue, { status: "prepared" }>
  | (Omit<Extract<SessionPreparedCompactionValue, { status: "prepared" }>, "plan"> & {
      plan: Omit<PreparedCompactionPlan, "retained">;
      retainedEventCount: number;
    });

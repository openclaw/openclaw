import type { CompactionResult } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { BoundedConversation } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { BeforeCompactionHookMetrics } from "../../agents/embedded-agent-runner/compaction-hook-metrics.types.js";
import type {
  PreparedCompactionEntryFact,
  PreparedCompactionPlan,
  PreparedCompactionPlanOptions,
} from "../../agents/embedded-agent-runner/prepared-compaction-plan.types.js";
import type { PreparedCompactionReplayOptions } from "../../agents/embedded-agent-runner/replay-history.types.js";
import type { ModelSnapshotEntry } from "../../agents/embedded-agent-runner/replay-model-snapshot.js";
import type { SessionHeader } from "../../agents/sessions/session-manager-types.js";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { CompactionReadCounts } from "./session-compaction-render.worker.js";
import type { SessionCompactionPreparation } from "./session-history-read.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { SessionTranscriptHydrationWorkerInput } from "./session-transcript-hydration.types.js";

/** Invocation-owned facts can carry Gateway preflight into planning without another extraction. */
export type PreparedCompactionSource = {
  entries: PreparedCompactionEntryFact[];
  header?: SessionHeader;
  version: SessionTranscriptContextVersion;
  expectedIdentity?: DatabaseFileIdentity;
  leafEntryId: string | null;
  boundaryCount: number;
  persistedSuffixStartSeq: number;
  transcriptMutationAt: number | null;
  eventCount: number;
};

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
    | { kind: "preflight" }
    | {
        kind: "plan";
        options: PreparedCompactionPlanOptions;
        replay: PreparedCompactionReplayOptions;
        source?: PreparedCompactionSource;
      }
    | {
        kind: "render";
        entries: PreparedCompactionPlan["selections"]["history"];
        version: SessionTranscriptContextVersion;
        maxChars: number;
      }
    | {
        kind: "finalize";
        version: SessionTranscriptContextVersion;
        retainedSequences: number[];
        preparation: PreparedCompactionPlan["preparation"];
        summary: CompactionResult;
        work: Pick<
          PreparedCompactionPlan,
          "requestBudget" | "requestTokenLimit" | "pendingEntryId"
        > & { itemId: string };
        replay: PreparedCompactionReplayOptions;
      };
};

type PreparedCompactionReplayMetadata = {
  hasThinkingEntry: boolean;
  modelSnapshot?: ModelSnapshotEntry;
  needsGoogleTurnOrderingMarker: boolean;
};

export type SessionPreparedCompactionBody =
  | { status: "rendered"; conversation: BoundedConversation }
  | {
      status: "finalized";
      transcriptMutationAt: number | null;
      tokensAfter: number;
      messageCountAfter: number;
      retainedReplayMetrics: BeforeCompactionHookMetrics;
    }
  | ({
      status: "preflight";
      source: PreparedCompactionSource;
      eventCount: number;
      reason?: "Already compacted" | "Nothing to compact (session too small)";
    } & SessionCompactionPreparation)
  | ({
      status: "skipped";
      reason: string;
      beforeHookMetrics: BeforeCompactionHookMetrics;
    } & PreparedCompactionReplayMetadata)
  | ({
      status: "prepared";
      plan: PreparedCompactionPlan;
      header: SessionHeader;
      version: SessionTranscriptContextVersion;
      leafEntryId: string | null;
      boundaryCount: number;
      persistedSuffixStartSeq: number;
      transcriptMutationAt: number | null;
      beforeHookMetrics: BeforeCompactionHookMetrics;
      hasRealConversation: boolean;
    } & PreparedCompactionReplayMetadata);

export type SessionPreparedCompactionValue = {
  kind: "compaction-preparation";
  reads: CompactionReadCounts;
} & SessionPreparedCompactionBody;

export type SessionPreparedCompactionWireValue = SessionPreparedCompactionValue;

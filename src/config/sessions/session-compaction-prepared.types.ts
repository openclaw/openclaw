import type {
  CompactionFactPreparation,
  CompactionPreparationEntryFact,
} from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import type {
  CompactionSettings,
  CompactionResult,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type {
  ConversationMessageFact,
  ConversationEntryDescriptor,
  BoundedConversation,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { PreparedCompactionMetadataFacts } from "../../agents/embedded-agent-runner/prepared-compaction-metadata.types.js";
import type {
  CompactionMessageSource,
  CompactionSelections,
  PreparedCompactionPlan,
  PreparedCompactionPlanOptions,
  PreparedCompactionReplayMetrics,
} from "../../agents/embedded-agent-runner/prepared-compaction-plan.types.js";
import type {
  ModelSnapshotState,
  ModelSnapshotEntry,
} from "../../agents/embedded-agent-runner/replay-session-state.types.js";
import type { SessionHeader } from "../../agents/sessions/session-manager-types.js";
import type { SessionCompactionPreparation } from "./session-history-read.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { SessionTranscriptHydrationWorkerInput } from "./session-transcript-hydration-input.types.js";

export type PreparedCompactionEntry = CompactionPreparationEntryFact & {
  parentId: string | null;
  idempotencyKey?: string;
  conversation: ConversationMessageFact<CompactionMessageSource>[];
};
export type PreparedCompactionSource = {
  entries: PreparedCompactionEntry[];
  metadata: PreparedCompactionMetadataFacts;
  snapshotState: ModelSnapshotState;
  header?: SessionHeader;
  version: SessionTranscriptContextVersion;
  leafEntryId: string | null;
  boundaryCount: number;
  persistedSuffixStartSeq: number;
  transcriptMutationAt: number | null;
  eventCount: number;
};
export type CompactionReadCounts = {
  extractedRows: number;
  extractedBytes: number;
  selectedRows: number;
  selectedBytes: number;
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
        settings: CompactionSettings;
        requestState?: "unresolved";
        work?: Omit<PreparedCompactionPlanOptions, "settings" | "requestState">;
        source?: PreparedCompactionSource;
      }
    | {
        kind: "finalize";
        version: SessionTranscriptContextVersion;
        retainedSequences: number[];
        summary: CompactionResult;
        work: Pick<
          PreparedCompactionPlan,
          "requestBudget" | "requestTokenLimit" | "pendingEntryId"
        > & { itemId: string };
        reportingBudget?: PreparedCompactionPlan["requestBudget"];
      }
    | {
        kind: "render";
        entries: ConversationEntryDescriptor<CompactionMessageSource>[];
        version: SessionTranscriptContextVersion;
        maxChars: number;
      };
};
export type SessionPreparedCompactionValue = {
  kind: "compaction-preparation";
  reads: CompactionReadCounts;
  modelSnapshot?: ModelSnapshotEntry;
} & (
  | ({
      status: "preflight";
      source: PreparedCompactionSource;
      reason?: "Already compacted" | "Nothing to compact (session too small)";
    } & SessionCompactionPreparation)
  | {
      status: "prepared";
      source: PreparedCompactionSource;
      preparation: CompactionFactPreparation;
      plan: PreparedCompactionPlan;
      beforeHookMetrics: PreparedCompactionReplayMetrics;
      hasRealConversation: boolean;
      selections: CompactionSelections;
    }
  | {
      status: "skipped";
      source: PreparedCompactionSource;
      beforeHookMetrics: PreparedCompactionReplayMetrics;
      hasRealConversation: boolean;
    }
  | {
      status: "finalized";
      transcriptMutationAt: number | null;
      tokensAfter: number;
      reportingTokensAfter: number;
      messageCountAfter: number;
    }
  | { status: "rendered"; conversation: BoundedConversation }
);

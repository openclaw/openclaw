import type { CompactionSettings } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type {
  BoundedConversation,
  PreparedConversationMessage,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { SessionTreeEntry } from "../../../packages/agent-core/src/harness/types.js";
import type { CompactionRequestConstraints } from "../../agents/sessions/compaction/request-budget.types.js";
import type {
  PreparedCompaction,
  PreparedCompactionFacts,
} from "../../agents/sessions/prepared-compaction.types.js";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";

type SessionCompactionSourceRead = {
  kind: "compaction-source";
  database: { agentId: string; path: string };
  target: SessionTranscriptRuntimeTarget;
  resolvedScope: ResolvedTranscriptReadScope;
  expectedIdentity?: DatabaseFileIdentity;
  admission?: UserTurnTranscriptAdmissionReceipt;
};
export type SessionCompactionPlanRequest = SessionCompactionSourceRead &
  CompactionRequestConstraints & {
    phase: "plan";
    requestState?: "unresolved";
    settings: CompactionSettings;
    manual: boolean;
    safeguard: { recentTurnsPreserve: number; qualityGuardEnabled: boolean };
  };
/**
 * Payload-free selection facts for one summary input. Each element names the
 * transcript row whose message renders at that serialization position.
 */
export type SessionCompactionSourceEntries = {
  seqs: number[];
  facts: PreparedConversationMessage[];
};
export type SessionCompactionSerializeRequest = SessionCompactionSourceRead & {
  phase: "serialize";
  version: SessionTranscriptContextVersion;
  entries: SessionCompactionSourceEntries;
  maxChars: number;
};
export type SessionCompactionSourceRequest =
  | SessionCompactionPlanRequest
  | SessionCompactionSerializeRequest;
export type SessionCompactionSourceName = "history" | "turnPrefix" | "reconciliation";
export type SessionCompactionSourcePlan = {
  facts: PreparedCompactionFacts;
  header: TranscriptEvent;
  retained: SessionTreeEntry[];
  version: SessionTranscriptContextVersion;
};
export type SessionCompactionSourceReply =
  | { kind: "skipped"; reason: string }
  | {
      kind: "prepared";
      plan: SessionCompactionSourcePlan;
      sources: Record<SessionCompactionSourceName, SessionCompactionSourceEntries>;
    }
  | { kind: "serialized"; conversation: BoundedConversation };
export type SessionCompactionSourceConsumer = (
  plan: SessionCompactionSourcePlan,
  source: PreparedCompaction,
) => Promise<void>;

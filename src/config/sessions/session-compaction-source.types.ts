import type { CompactionSettings } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { BoundedConversation } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { SessionTreeEntry } from "../../../packages/agent-core/src/harness/types.js";
import type { CompactionRequestConstraints } from "../../agents/sessions/compaction/request-budget.js";
import type {
  PreparedCompaction,
  PreparedCompactionFacts,
} from "../../agents/sessions/prepared-compaction.js";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";

export type SessionCompactionSourceRequest = CompactionRequestConstraints & {
  requestState?: "unresolved";
  kind: "compaction-source";
  database: { agentId: string; path: string };
  target: SessionTranscriptRuntimeTarget;
  resolvedScope: ResolvedTranscriptReadScope;
  expectedIdentity?: DatabaseFileIdentity;
  admission?: UserTurnTranscriptAdmissionReceipt;
  settings: CompactionSettings;
  manual: boolean;
  safeguard: { recentTurnsPreserve: number; qualityGuardEnabled: boolean };
};
export type SessionCompactionSourcePlan = {
  facts: PreparedCompactionFacts;
  header: TranscriptEvent;
  retained: SessionTreeEntry[];
  version: SessionTranscriptContextVersion;
};
export type SessionCompactionSourceCommand =
  | { kind: "serialize"; source: "history" | "turnPrefix" | "reconciliation"; maxChars: number }
  | { kind: "close" };
export type SessionCompactionSourceReply =
  | { kind: "skipped"; reason: string }
  | { kind: "prepared"; plan: SessionCompactionSourcePlan }
  | { kind: "serialized"; conversation: BoundedConversation };
export type SessionCompactionSourceConsumer = (
  plan: SessionCompactionSourcePlan,
  source: PreparedCompaction,
) => Promise<void>;

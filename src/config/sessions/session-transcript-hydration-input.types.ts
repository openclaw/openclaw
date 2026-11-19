import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryCohortRequest } from "./session-entry-read.types.js";
import type { SessionTranscriptContextSelection } from "./session-history-read.types.js";
import type { SessionTranscriptAnchorEntry } from "./session-transcript-anchor-read.types.js";

export type SessionTranscriptHydrationWorkerInput = {
  kind: "transcript-hydration";
  database: { agentId: string; path: string };
  target: SessionTranscriptReadScope;
  resolvedScope: ResolvedTranscriptReadScope;
  expectedIdentity?: DatabaseFileIdentity;
  afterSeq?: number;
  includeEventJson?: boolean;
  compaction?: true;
  limits?: SessionTranscriptContextSelection;
  transcript?: SessionEntryCohortRequest["transcript"];
  preparedEntry?: SessionTranscriptAnchorEntry;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

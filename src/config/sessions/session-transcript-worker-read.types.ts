import type { SessionCostUsageCacheRead } from "../../infra/session-cost-usage-cache-read.js";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { VoiceSessionLookup } from "../../talk/client-voice-session-store.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptVisibleMessageDeltaLimits,
} from "./session-accessor.sqlite-contract.js";
import type {
  ResolvedTranscriptReadScope,
  ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptEventMatch,
} from "./session-history-read.types.js";
import type { SessionTranscriptAnchorSelection } from "./session-transcript-anchor-read.kernel.js";
import type { SessionTranscriptSearchParams } from "./session-transcript-search.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type SessionTranscriptEventMatchRequest = {
  target: ResolvedTranscriptReadScope;
  match: SessionTranscriptEventMatch;
};

export type SessionTranscriptMatchWorkerInput = {
  kind: "transcript-match";
  database: { agentId: string; path: string };
  request: SessionTranscriptEventMatchRequest;
};

export type SessionTranscriptSearchWorkerInput = {
  kind: "transcript-search";
  database: { agentId: string; path: string };
  params: SessionTranscriptSearchParams;
};

export type SessionTranscriptSearchCurrentWorkerInput = {
  kind: "transcript-search-current";
  database: { agentId: string; path: string };
  revision: string;
  env: NodeJS.ProcessEnv;
};

export type SessionProjectionStatusWorkerInput = {
  kind: "projection-status";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  sessionId: string;
};

export type SessionTranscriptAnchorsWorkerInput = {
  kind: "transcript-anchors";
  database: { agentId: string; path: string };
  resolved: ResolvedTranscriptScope;
  selection: SessionTranscriptAnchorSelection;
  expectedIdentity: DatabaseFileIdentity;
};

export type SessionProgressCardWorkerInput = {
  kind: "session-progress-card";
  database: { agentId: string; path: string };
  sessionKey: string;
  env: NodeJS.ProcessEnv;
};

export type SessionModelContextWorkerInput = {
  kind: "model-context";
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
  limits?: SessionModelContextLimits;
  expectedIdentity?: DatabaseFileIdentity;
};

export type SessionTranscriptWatermarkWorkerInput = {
  kind: "transcript-watermark";
  database: { agentId: string; path: string };
  scope: SessionTranscriptReadScope;
  expectedIdentity?: DatabaseFileIdentity;
};

export type SessionTranscriptMessagePresenceWorkerInput = Omit<
  SessionTranscriptWatermarkWorkerInput,
  "kind"
> & {
  kind: "transcript-message-presence";
};

export type SessionTranscriptDeltaWorkerInput = Omit<
  SessionTranscriptWatermarkWorkerInput,
  "kind"
> & {
  resolved: ResolvedTranscriptReadScope;
  admission?: UserTurnTranscriptAdmissionReceipt;
} & (
    | { kind: "transcript-raw-delta"; limits: SessionTranscriptRawDeltaLimits }
    | { kind: "transcript-visible-delta"; limits: SessionTranscriptVisibleMessageDeltaLimits }
  );

export type SessionMemoryCaptureWorkerInput = Omit<
  SessionTranscriptWatermarkWorkerInput,
  "kind"
> & {
  kind: "session-memory-capture";
  resolved: ResolvedTranscriptReadScope;
  messageCount: number;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type VoiceSessionsWorkerInput = {
  kind: "voice-sessions";
  database: { agentId: string; path: string };
  request: VoiceSessionLookup;
  env: NodeJS.ProcessEnv;
};

export type SessionUsageCacheWorkerInput = {
  kind: "usage-cache";
  database: { agentId: string; path: string };
  request: SessionCostUsageCacheRead;
  env: NodeJS.ProcessEnv;
};

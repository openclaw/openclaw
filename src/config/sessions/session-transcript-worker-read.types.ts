import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { SessionTranscriptEventMatch } from "../../sessions/transcript-visible-record.js";
import type {
  ResolvedTranscriptReadScope,
  ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionTranscriptAnchorSelection } from "./session-transcript-anchor-read.kernel.js";
import type { SessionTranscriptSearchParams } from "./session-transcript-search.types.js";

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

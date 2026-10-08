import type { AgentMessage } from "@openclaw/agent-core";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionBranchSummary,
} from "./session-accessor.types.js";
import type { SessionTranscriptWatermark } from "./session-transcript-context-version.types.js";

export type { SessionTranscriptWatermark } from "./session-transcript-context-version.types.js";

export type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionBranchSummarySnapshot = SessionTranscriptWatermark & {
  branches: SessionBranchSummary[];
  appendSafe?: boolean;
};

export type SessionBranchSummaryReadResult =
  | ({ status: "ok" } & SessionBranchSummarySnapshot)
  | { status: "missing-session" | "failed" };

export type SessionModelContextLimits = {
  maxBytes: number;
  maxEvents: number;
  /** Detached model views may omit result bodies; evidence and fork readers remain strict. */
  toolResultOverflow?: "omit";
};

export type SessionTranscriptModelContext = {
  events: TranscriptEvent[];
  version?: SessionTranscriptContextVersion;
};

export type SessionTranscriptReadSnapshot = {
  events: TranscriptEvent[];
  eventJson?: string[];
  eventSeqs?: number[];
  version: SessionTranscriptContextVersion;
};

export type SessionTranscriptContextSnapshot = {
  messages: AgentMessage[];
  header: unknown;
  version?: SessionTranscriptContextVersion;
};

export type PreparedSessionTranscriptHydration =
  | { kind: "full"; snapshot: SessionTranscriptReadSnapshot }
  | { kind: "bounded"; snapshot: SessionTranscriptBoundedActiveContext };

export type SessionPendingInputReceipt =
  | { runId: string; state: "pending"; cancelled?: true }
  | { runId: string; state: "consumed"; consumedByEventId: string };

export type SessionTranscriptEventMatch =
  | { kind: "latest" }
  | { kind: "visible-final"; runId: string }
  | {
      kind: "idempotency";
      key: string;
      assistant?: boolean;
      runId?: string;
      deliveryMirror?: boolean;
    }
  | { kind: "active-assistant"; runId: string };

export type SessionContextMessagesWorkerInput = {
  kind: "context-messages";
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  expectedIdentity?: import("../../infra/sqlite-worker-identity.js").DatabaseFileIdentity;
};

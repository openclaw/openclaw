import type { AgentMessage } from "@openclaw/agent-core";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";

export type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionTranscriptWatermark = {
  generation: string | null;
  maxSeq: number | null;
};

export type SessionBranchSummaryReadResult =
  | ({ status: "ok"; branches: SessionBranchSummary[] } & SessionTranscriptWatermark)
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

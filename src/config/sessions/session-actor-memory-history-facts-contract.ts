import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionTranscriptBoundedMessageTailOptions,
  SessionTranscriptBoundedMessageTailPage,
  SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import type {
  LatestTranscriptAssistantText,
  SessionTranscriptStats,
  TranscriptEvent,
} from "./session-accessor.types.js";
import type {
  SessionBranchSummaryReadResult,
  SessionPreviewItem,
  SessionTitleFields,
  SessionTranscriptEventMatch,
  SessionTranscriptWatermark,
} from "./session-history-read.types.js";
import type {
  SessionTranscriptAccountingOptions,
  SessionTranscriptAccountingSnapshot,
} from "./session-transcript-accounting.types.js";
import type { SessionTranscriptAnchorSelection } from "./session-transcript-anchor-read.kernel.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import type {
  SessionTranscriptCurrentTurnEntryRead,
  SessionTranscriptCurrentTurnEntryRequest,
  SessionTranscriptMaintenanceFacts,
  SessionTranscriptMaintenanceRead,
} from "./session-transcript-hydration.types.js";

type Reads = {
  title: {
    input: { includeInterSession?: boolean };
    output: { kind: "session-title-fields"; fields: SessionTitleFields };
  };
  preview: {
    input: { maxItems: number; maxChars: number };
    output: { kind: "session-preview"; items: SessionPreviewItem[] };
  };
  branches: { input: Record<never, never>; output: SessionBranchSummaryReadResult };
  "current-turn-entry": {
    input: SessionTranscriptCurrentTurnEntryRequest;
    output: SessionTranscriptCurrentTurnEntryRead;
  };
  maintenance: {
    input: { request: SessionTranscriptMaintenanceRead };
    output: SessionTranscriptMaintenanceFacts;
  };
  stats: { input: Record<never, never>; output: SessionTranscriptStats };
  match: {
    input: { match: SessionTranscriptEventMatch };
    output: { kind: "transcript-match"; result: { event: TranscriptEvent } | undefined };
  };
  watermark: {
    input: Record<never, never>;
    output: { kind: "transcript-watermark"; watermark: SessionTranscriptWatermark };
  };
  "latest-assistant": {
    input: Record<never, never>;
    output: LatestTranscriptAssistantText | undefined;
  };
  "latest-active-message": {
    input: Record<never, never>;
    output: SessionTranscriptMessageEvent | undefined;
  };
  "message-presence": { input: Record<never, never>; output: boolean };
  "recent-active-events": { input: { maxEvents: number }; output: TranscriptEvent[] };
  accounting: {
    input: { options: SessionTranscriptAccountingOptions };
    output: SessionTranscriptAccountingSnapshot;
  };
  "bounded-tail": {
    input: { options: SessionTranscriptBoundedMessageTailOptions };
    output: SessionTranscriptBoundedMessageTailPage;
  };
  "visitor-source": {
    input: { offset?: number };
    output: { messages: Array<{ message: unknown; seq: number }>; nextOffset?: number };
  };
};

export type SessionActorMemoryHistoryFactsReads = {
  [Key in keyof Reads as `session.history.${Key}`]: {
    input: Reads[Key]["input"] & { sessionId?: string } & (Key extends
        | "title"
        | "preview"
        | "current-turn-entry"
        | "maintenance"
        | "latest-assistant"
        | "latest-active-message"
        | "recent-active-events"
        | "accounting"
        | "bounded-tail"
        | "visitor-source"
        ? { admission?: UserTurnTranscriptAdmissionReceipt }
        : Record<never, never>);
    output: Reads[Key]["output"];
  };
};

export type SessionActorMemoryAnchorReads = {
  "session.history.anchors": {
    input: SessionTranscriptAnchorSelection & { sessionId?: string };
    output: SessionTranscriptAnchorFacts;
  };
};

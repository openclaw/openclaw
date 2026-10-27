import type { SessionTranscriptWorkerInput } from "./session-transcript-worker.types.js";

const historyReadKinds = [
  "trajectory-events",
  "trajectory-retention",
  "board-snapshot",
  "board-widget-document",
  "transcript-match",
  "branch-summaries",
  "session-title-fields",
  "session-preview",
  "model-context",
  "context-messages",
  "transcript-watermark",
  "transcript-stats",
  "transcript-message-presence",
  "transcript-anchors",
  "transcript-raw-delta",
  "transcript-visible-delta",
  "transcript-latest-assistant",
  "session-memory-capture",
  "session-pending-input-receipts",
  "session-pending-input-source",
  "session-harness-completion-source",
] as const;
const historyReadKindSet: ReadonlySet<string> = new Set(historyReadKinds);

export type SessionHistoryReadOperationRequest = Extract<
  SessionTranscriptWorkerInput,
  { kind: (typeof historyReadKinds)[number] }
>;

export function isSessionHistoryReadOperation(
  request: SessionTranscriptWorkerInput,
): request is SessionHistoryReadOperationRequest {
  return historyReadKindSet.has(request.kind);
}

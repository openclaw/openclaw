import type { SessionTranscriptDisplayDeltaResult } from "./session-accessor.sqlite-history-query.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";

export const typedFailures = [
  {
    error: new SessionTranscriptColdError("cold-session"),
    reply: { kind: "cold", sessionId: "cold-session" },
  },
  {
    error: new SessionTranscriptProjectionUnavailableError("projected-session"),
    reply: { kind: "projection", sessionId: "projected-session" },
  },
  {
    error: new SessionTranscriptReadFenceError("fence failed"),
    reply: { kind: "fence", message: "fence failed" },
  },
];

export function createVisibilityFailureDelta(
  resetFirst: boolean,
): SessionTranscriptDisplayDeltaResult {
  const mirror = {
    role: "assistant",
    provider: "openclaw",
    model: "delivery-mirror",
    content: "Mirror",
    openclawDeliveryMirror: { kind: "channel-final", sourceAssistantMessageId: "before-cursor" },
  };
  const coordination = {
    role: "user",
    content: "Internal coordination",
    provenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: "agent:main:acp:source",
    },
  };
  return {
    kind: "page",
    cursor: "cursor",
    activeLeafEntryId: "message-1",
    hasMore: false,
    serializedBytes: 512,
    events: (resetFirst ? [mirror, coordination] : [coordination, mirror]).map(
      (message, index) => ({
        seq: index + 1,
        messageSeq: index + 1,
        event: { type: "message", id: `message-${index}`, message },
      }),
    ),
  };
}

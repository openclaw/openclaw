import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { selectChatSendAgentReplyPayloads } from "./chat-send-source-finalization.js";

describe("selectChatSendAgentReplyPayloads", () => {
  const sourceReply = setReplyPayloadMetadata(
    { text: "source reply" },
    {
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:main",
        text: "source reply",
        idempotencyKey: "source-reply-1",
      },
    },
  );
  const deliveredReplies = [
    { kind: "block" as const, payload: sourceReply },
    { kind: "final" as const, payload: { text: "answer" } },
    { kind: "final" as const, payload: { text: "status", isStatusNotice: true } },
    { kind: "final" as const, payload: sourceReply },
  ];

  it("selects final status and source replies when the agent succeeded", () => {
    expect(
      selectChatSendAgentReplyPayloads({
        deliveredReplies,
        hasReturnedAgentErrorPayloads: false,
      }),
    ).toEqual([{ text: "status", isStatusNotice: true }, sourceReply]);
  });

  it("keeps source replies but suppresses status notices after an agent error", () => {
    expect(
      selectChatSendAgentReplyPayloads({
        deliveredReplies,
        hasReturnedAgentErrorPayloads: true,
      }),
    ).toEqual([sourceReply]);
  });
});

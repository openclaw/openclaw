// Tests usage-line formatting for agent runner completion summaries.
import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForMessageToolDeliveryForReplyRoute,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { appendUsageLine } from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("preserves reply payload metadata when appending to an existing payload", () => {
    const payload = markReplyPayloadForMessageToolDeliveryForReplyRoute<ReplyPayload>({
      text: "fallback reply",
    });

    const [updated] = appendUsageLine([payload], "Usage: 1 in / 1 out");

    expect(updated).toBeDefined();
    expect(updated?.text).toBe("fallback reply\nUsage: 1 in / 1 out");
    expect(getReplyPayloadMetadata(updated)?.messageToolDeliveredForReplyRoute).toBe(true);
  });

  it("preserves reply payload metadata when appending usage text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = appendUsageLine([payload], "Usage: 12 in / 3 out");

    expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(updated)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:telegram:direct:123",
        idempotencyKey: "run-1:internal-source-reply:0",
        text: "message tool reply\nUsage: 12 in / 3 out",
      },
    });
  });
});

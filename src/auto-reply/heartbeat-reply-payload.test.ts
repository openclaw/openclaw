import { describe, expect, it } from "vitest";
import { resolveHeartbeatReplyPayload } from "./heartbeat-reply-payload.js";
import type { ReplyPayload } from "./types.js";

describe("resolveHeartbeatReplyPayload", () => {
  it("selects the last visible outbound payload instead of later reasoning", () => {
    const finalPayload: ReplyPayload = { text: "HEARTBEAT_OK" };
    const reasoningPayload: ReplyPayload = {
      text: "private chain of thought",
      isReasoning: true,
    };

    expect(resolveHeartbeatReplyPayload([finalPayload, reasoningPayload])).toBe(finalPayload);
  });

  it("selects the last visible outbound payload instead of later legacy-prefixed reasoning", () => {
    const finalPayload: ReplyPayload = { text: "Final alert" };

    expect(
      resolveHeartbeatReplyPayload([
        finalPayload,
        { text: "Reasoning:\n_private details_" },
        { text: "Thinking\n\n_private details_" },
        { text: "> reasoning:\n> _private details_" },
      ]),
    ).toBe(finalPayload);
  });

  it("returns undefined when the only payload is reasoning", () => {
    const reasoningPayload: ReplyPayload = {
      text: "private chain of thought",
      isReasoning: true,
    };

    expect(resolveHeartbeatReplyPayload(reasoningPayload)).toBeUndefined();
    expect(resolveHeartbeatReplyPayload([reasoningPayload])).toBeUndefined();
    expect(resolveHeartbeatReplyPayload({ text: "Reasoning:\n_private details_" })).toBeUndefined();
    expect(
      resolveHeartbeatReplyPayload({ text: "> thinking\n> _private details_" }),
    ).toBeUndefined();
  });

  it("continues scanning past empty and reasoning payloads", () => {
    const visiblePayload: ReplyPayload = { text: "Final alert" };
    const payloads: ReplyPayload[] = [
      { text: "Earlier alert" },
      visiblePayload,
      { text: "internal thinking", isReasoning: true },
      {},
    ];

    expect(resolveHeartbeatReplyPayload(payloads)).toBe(visiblePayload);
  });
});

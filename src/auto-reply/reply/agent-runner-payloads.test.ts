import { describe, expect, it } from "vitest";
import { buildReplyPayloads } from "./agent-runner-payloads.js";

describe("buildReplyPayloads", () => {
  it("drops internal-only payloads before delivery", () => {
    const result = buildReplyPayloads({
      payloads: [
        { text: "⚠️ 📝 Edit failed", isError: true, internalOnly: true },
        { text: "Final answer" },
      ],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
    });

    expect(result.replyPayloads).toEqual([{ text: "Final answer" }]);
  });

  it("returns no reply payloads when only internal-only payloads remain", () => {
    const result = buildReplyPayloads({
      payloads: [{ text: "⚠️ 📝 Edit failed", isError: true, internalOnly: true }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
    });

    expect(result.replyPayloads).toEqual([]);
  });
});

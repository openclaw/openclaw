import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForMessageToolDeliveryForReplyRoute,
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
});

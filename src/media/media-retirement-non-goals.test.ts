import { describe, expect, it } from "vitest";
import { filterMessagingToolMediaDuplicates } from "../auto-reply/reply/reply-payloads-dedupe.js";

describe("media retirement outbound non-goals", () => {
  it("continues deduplicating lowercase ReplyPayload media fields", () => {
    expect(
      filterMessagingToolMediaDuplicates({
        payloads: [
          {
            mediaUrl: "https://example.test/one.png",
            mediaUrls: ["https://example.test/two.png", "https://example.test/three.png"],
          },
        ],
        sentMediaUrls: ["https://example.test/one.png", "https://example.test/two.png"],
      }),
    ).toEqual([{ mediaUrl: undefined, mediaUrls: ["https://example.test/three.png"] }]);
  });
});

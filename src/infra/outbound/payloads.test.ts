import { describe, expect, it } from "vitest";
import {
  formatOutboundPayloadLog,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
  normalizeReplyPayloadsForDelivery,
} from "./payloads.js";

// ── normalizeReplyPayloadsForDelivery ──────────────────────────

describe("normalizeReplyPayloadsForDelivery", () => {
  it("returns empty array for empty input", () => {
    expect(normalizeReplyPayloadsForDelivery([])).toEqual([]);
  });

  it("passes through plain text payload", () => {
    const result = normalizeReplyPayloadsForDelivery([{ text: "hello" }]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("hello");
  });

  it("strips MEDIA: tags from text and populates mediaUrls", () => {
    const result = normalizeReplyPayloadsForDelivery([
      { text: "caption\nMEDIA:https://x.test/a.png" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("caption");
    expect(result[0].mediaUrls).toContain("https://x.test/a.png");
  });

  it("deduplicates media URLs", () => {
    const result = normalizeReplyPayloadsForDelivery([
      {
        text: "dup",
        mediaUrl: "https://x.test/a.png",
        mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
      },
    ]);
    expect(result).toHaveLength(1);
    const urls = result[0].mediaUrls ?? [];
    expect(urls.filter((u) => u === "https://x.test/a.png")).toHaveLength(1);
  });

  it("filters out empty text-only payloads with no media", () => {
    const result = normalizeReplyPayloadsForDelivery([{ text: "" }]);
    expect(result).toHaveLength(0);
  });

  it("preserves payload with only mediaUrl", () => {
    const result = normalizeReplyPayloadsForDelivery([{ mediaUrl: "https://x.test/a.png" }]);
    expect(result).toHaveLength(1);
  });

  it("preserves channelData payloads", () => {
    const result = normalizeReplyPayloadsForDelivery([{ channelData: { line: { msg: "flex" } } }]);
    expect(result).toHaveLength(1);
    expect(result[0].channelData).toBeDefined();
  });

  it("handles multiple payloads", () => {
    const result = normalizeReplyPayloadsForDelivery([
      { text: "first" },
      { text: "second" },
      { text: "" },
    ]);
    expect(result).toHaveLength(2);
  });

  it("trims media URL whitespace", () => {
    const result = normalizeReplyPayloadsForDelivery([
      { text: "pic", mediaUrl: "  https://x.test/a.png  " },
    ]);
    const urls = result[0].mediaUrls ?? [];
    expect(urls[0]).toBe("https://x.test/a.png");
  });
});

// ── normalizeOutboundPayloadsForJson ──────────────────────────

describe("normalizeOutboundPayloadsForJson", () => {
  it("normalizes payloads with mediaUrl and mediaUrls", () => {
    expect(
      normalizeOutboundPayloadsForJson([
        { text: "hi" },
        { text: "photo", mediaUrl: "https://x.test/a.jpg" },
        { text: "multi", mediaUrls: ["https://x.test/1.png"] },
      ]),
    ).toEqual([
      { text: "hi", mediaUrl: null, mediaUrls: undefined, channelData: undefined },
      {
        text: "photo",
        mediaUrl: "https://x.test/a.jpg",
        mediaUrls: ["https://x.test/a.jpg"],
        channelData: undefined,
      },
      {
        text: "multi",
        mediaUrl: null,
        mediaUrls: ["https://x.test/1.png"],
        channelData: undefined,
      },
    ]);
  });

  it("keeps mediaUrl null for multi MEDIA tags", () => {
    expect(
      normalizeOutboundPayloadsForJson([
        {
          text: "MEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
        },
      ]),
    ).toEqual([
      {
        text: "",
        mediaUrl: null,
        mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        channelData: undefined,
      },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeOutboundPayloadsForJson([])).toEqual([]);
  });

  it("returns empty array for non-renderable payloads", () => {
    expect(normalizeOutboundPayloadsForJson([{ text: "" }])).toEqual([]);
  });
});

// ── normalizeOutboundPayloads ──────────────────────────

describe("normalizeOutboundPayloads", () => {
  it("keeps channelData-only payloads", () => {
    const channelData = { line: { flexMessage: { altText: "Card", contents: {} } } };
    const normalized = normalizeOutboundPayloads([{ channelData }]);
    expect(normalized).toEqual([{ text: "", mediaUrls: [], channelData }]);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeOutboundPayloads([])).toEqual([]);
  });

  it("strips empty payloads", () => {
    expect(normalizeOutboundPayloads([{ text: "" }])).toEqual([]);
  });

  it("normalizes text-only payload", () => {
    const result = normalizeOutboundPayloads([{ text: "hello" }]);
    expect(result).toEqual([{ text: "hello", mediaUrls: [] }]);
  });

  it("normalizes media payload", () => {
    const result = normalizeOutboundPayloads([
      { text: "caption", mediaUrl: "https://x.test/a.png" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("caption");
    expect(result[0].mediaUrls).toContain("https://x.test/a.png");
  });

  it("extracts MEDIA: tags from text", () => {
    const result = normalizeOutboundPayloads([{ text: "hello\nMEDIA:https://x.test/pic.jpg" }]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("hello");
    expect(result[0].mediaUrls).toContain("https://x.test/pic.jpg");
  });

  it("omits empty channelData", () => {
    const result = normalizeOutboundPayloads([{ text: "hi", channelData: {} }]);
    expect(result).toHaveLength(1);
    expect(result[0].channelData).toBeUndefined();
  });
});

// ── formatOutboundPayloadLog ──────────────────────────

describe("formatOutboundPayloadLog", () => {
  it("trims trailing text and appends media lines", () => {
    expect(
      formatOutboundPayloadLog({
        text: "hello  ",
        mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
      }),
    ).toBe("hello\nMEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png");
  });

  it("logs media-only payloads", () => {
    expect(
      formatOutboundPayloadLog({
        text: "",
        mediaUrls: ["https://x.test/a.png"],
      }),
    ).toBe("MEDIA:https://x.test/a.png");
  });

  it("logs text-only payloads", () => {
    expect(formatOutboundPayloadLog({ text: "hello", mediaUrls: [] })).toBe("hello");
  });

  it("returns empty string for empty payload", () => {
    expect(formatOutboundPayloadLog({ text: "", mediaUrls: [] })).toBe("");
  });
});

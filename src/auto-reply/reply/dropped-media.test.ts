import { describe, expect, it } from "vitest";
import { formatDroppedMediaNotice } from "../../infra/outbound/deliver.js";
import {
  normalizeOutboundPayloads,
  normalizeReplyPayloadsForDelivery,
  summarizeOutboundPayloadForTransport,
} from "../../infra/outbound/payloads.js";
import type { DroppedMediaItem } from "../reply-payload.js";
import { resolveDroppedMediaCode, sanitizeMediaDisplayName } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

describe("DroppedMedia types and helpers", () => {
  describe("sanitizeMediaDisplayName", () => {
    it("strips directory components from absolute path", () => {
      expect(sanitizeMediaDisplayName("/home/user/docs/screenshot.png")).toBe("screenshot.png");
    });

    it("strips directory components from relative path", () => {
      expect(sanitizeMediaDisplayName("./images/photo.jpg")).toBe("photo.jpg");
    });

    it("returns filename as-is when no directory", () => {
      expect(sanitizeMediaDisplayName("file.txt")).toBe("file.txt");
    });

    it("returns (inline data) for data: URLs", () => {
      expect(sanitizeMediaDisplayName("data:image/png;base64,iVBORw0KGgo...")).toBe(
        "(inline data)",
      );
      expect(sanitizeMediaDisplayName("DATA:text/plain;base64,abc")).toBe("(inline data)");
    });

    it("handles paths with forward slashes in Windows-style input", () => {
      // On unix, path.basename only splits on '/' so we test with forward slashes.
      expect(sanitizeMediaDisplayName("C:/Users/docs/report.pdf")).toBe("report.pdf");
    });

    it("handles Windows backslash paths", () => {
      expect(sanitizeMediaDisplayName("C:\\Users\\docs\\report.pdf")).toBe("report.pdf");
      expect(sanitizeMediaDisplayName("\\\\server\\share\\file.txt")).toBe("file.txt");
    });

    it("never exposes full path in displayName", () => {
      const result = sanitizeMediaDisplayName("/secret/internal/path/to/image.png");
      expect(result).toBe("image.png");
      expect(result).not.toContain("/secret");
      expect(result).not.toContain("/internal");
    });
  });

  describe("resolveDroppedMediaCode", () => {
    it("returns blocked-path for blocked errors", () => {
      expect(resolveDroppedMediaCode(new Error("file path blocked by policy"))).toBe(
        "blocked-path",
      );
    });

    it("returns data-url-rejected for data URL errors", () => {
      expect(resolveDroppedMediaCode(new Error("data URL not allowed"))).toBe("data-url-rejected");
    });

    it("returns file-not-accessible for ENOENT", () => {
      expect(resolveDroppedMediaCode(new Error("ENOENT: no such file"))).toBe(
        "file-not-accessible",
      );
    });

    it("returns unknown for unrecognized Error", () => {
      expect(resolveDroppedMediaCode(new Error("something unexpected"))).toBe("unknown");
    });

    it("returns data-url-rejected for data: prefix via regex", () => {
      expect(resolveDroppedMediaCode(new Error("Rejected data:image/png;base64,abc"))).toBe(
        "data-url-rejected",
      );
    });

    it("does not false-positive on metadata: strings", () => {
      expect(resolveDroppedMediaCode(new Error("invalid metadata: field missing"))).toBe("unknown");
    });

    it("returns unknown for non-Error values", () => {
      expect(resolveDroppedMediaCode("string error")).toBe("unknown");
      expect(resolveDroppedMediaCode(42)).toBe("unknown");
      expect(resolveDroppedMediaCode(null)).toBe("unknown");
    });
  });
});

describe("formatDroppedMediaNotice", () => {
  it("returns empty string for empty array", () => {
    expect(formatDroppedMediaNotice([])).toBe("");
  });

  it("formats single file notice", () => {
    const dropped: DroppedMediaItem[] = [
      { displayName: "screenshot.png", code: "file-not-accessible" },
    ];
    const result = formatDroppedMediaNotice(dropped);
    expect(result).toBe("\u26a0 Attachment not sent: `screenshot.png` (file not accessible)");
  });

  it("formats multiple file notice", () => {
    const dropped: DroppedMediaItem[] = [
      { displayName: "file1.png", code: "blocked-path" },
      { displayName: "file2.jpg", code: "file-not-accessible" },
    ];
    const result = formatDroppedMediaNotice(dropped);
    expect(result).toContain("\u26a0 2 attachments not sent:");
    expect(result).toContain("\u2022 `file1.png` \u2014 file path blocked");
    expect(result).toContain("\u2022 `file2.jpg` \u2014 file not accessible");
  });

  it("uses user-friendly reason labels, not internal codes", () => {
    const dropped: DroppedMediaItem[] = [
      { displayName: "a.png", code: "normalization-failed" },
      { displayName: "b.png", code: "data-url-rejected" },
    ];
    const result = formatDroppedMediaNotice(dropped);
    expect(result).not.toContain("normalization-failed");
    expect(result).not.toContain("data-url-rejected");
    expect(result).toContain("file not accessible");
    expect(result).toContain("data URL not supported");
  });
});

describe("droppedMedia in payload pipeline", () => {
  it("passes droppedMedia through summarizeOutboundPayloadForTransport", () => {
    const payload: ReplyPayload = {
      text: "hello",
      droppedMedia: [{ displayName: "file.png", code: "file-not-accessible" }],
    };
    const summary = summarizeOutboundPayloadForTransport(payload);
    expect(summary.droppedMedia).toEqual([
      { displayName: "file.png", code: "file-not-accessible" },
    ]);
  });

  it("does not include droppedMedia when absent", () => {
    const payload: ReplyPayload = { text: "hello" };
    const summary = summarizeOutboundPayloadForTransport(payload);
    expect(summary.droppedMedia).toBeUndefined();
  });

  it("normalizeReplyPayloadsForDelivery preserves payloads that only have droppedMedia", () => {
    const payloads: ReplyPayload[] = [
      {
        text: "",
        droppedMedia: [{ displayName: "img.png", code: "blocked-path" }],
      },
    ];
    const result = normalizeReplyPayloadsForDelivery(payloads);
    expect(result).toHaveLength(1);
    expect(result[0].droppedMedia).toEqual([{ displayName: "img.png", code: "blocked-path" }]);
  });

  it("normalizeOutboundPayloads preserves droppedMedia on payloads with text", () => {
    const payloads: ReplyPayload[] = [
      {
        text: "Here is the file",
        droppedMedia: [{ displayName: "doc.pdf", code: "file-not-accessible" }],
      },
    ];
    const result = normalizeOutboundPayloads(payloads);
    expect(result).toHaveLength(1);
    expect(result[0].droppedMedia).toEqual([
      { displayName: "doc.pdf", code: "file-not-accessible" },
    ]);
  });

  it("does not skip block reply with empty text but droppedMedia", () => {
    // This tests that payloads with only droppedMedia (no text, no media) are
    // not filtered out by the outbound pipeline.
    const payloads: ReplyPayload[] = [
      {
        text: "",
        mediaUrl: undefined,
        mediaUrls: undefined,
        droppedMedia: [{ displayName: "secret.png", code: "blocked-path" }],
      },
    ];
    const result = normalizeReplyPayloadsForDelivery(payloads);
    expect(result).toHaveLength(1);
  });
});

describe("reply-media-paths normalizer droppedMedia collection", () => {
  it("collects droppedMedia with sanitized displayName from catch block", async () => {
    const { createReplyMediaPathNormalizer } = await import("./reply-media-paths.js");

    const normalizer = createReplyMediaPathNormalizer({
      cfg: {} as any,
      workspaceDir: "/tmp/workspace",
    });

    const payload: ReplyPayload = {
      text: "check this",
      mediaUrl: "https://example.com/valid.png",
      mediaUrls: ["https://example.com/valid.png"],
    };

    // A remote passthrough URL should not be dropped.
    const result = await normalizer(payload);
    expect(result.droppedMedia).toBeUndefined();
    expect(result.mediaUrls).toEqual(["https://example.com/valid.png"]);
  });

  it("populates droppedMedia when normalizeMediaSource throws for an item", async () => {
    const { createReplyMediaPathNormalizer } = await import("./reply-media-paths.js");

    const normalizer = createReplyMediaPathNormalizer({
      cfg: {} as any,
      workspaceDir: "/tmp/workspace",
    });

    // data: URLs trigger assertMediaNotDataUrl to throw inside normalizeMediaSource,
    // exercising the per-item catch block in the normalizer loop.
    const payload: ReplyPayload = {
      text: "check this",
      mediaUrls: ["data:image/png;base64,abc", "https://example.com/ok.png"],
    };

    const result = await normalizer(payload);
    expect(result.droppedMedia).toHaveLength(1);
    expect(result.droppedMedia![0].code).toBe("data-url-rejected");
    // sanitizeMediaDisplayName returns "(inline data)" for data: URLs.
    expect(result.droppedMedia![0].displayName).toBe("(inline data)");
    // The valid remote URL should still be kept.
    expect(result.mediaUrls).toEqual(["https://example.com/ok.png"]);
  });
});

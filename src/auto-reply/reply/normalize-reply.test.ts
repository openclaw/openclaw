import { describe, expect, it } from "vitest";
import { normalizeReplyPayload } from "./normalize-reply.js";

describe("normalizeReplyPayload", () => {
  describe("NO_REPLY suppression", () => {
    it("returns null for exact NO_REPLY token", () => {
      expect(normalizeReplyPayload({ text: "NO_REPLY" })).toBeNull();
    });

    it("returns null for NO_REPLY with surrounding whitespace", () => {
      expect(normalizeReplyPayload({ text: "  NO_REPLY  " })).toBeNull();
    });

    it("passes through normal text", () => {
      const result = normalizeReplyPayload({ text: "Hello, world!" });
      expect(result?.text).toBe("Hello, world!");
    });
  });

  describe("ANNOUNCE_SKIP suppression (#45084)", () => {
    it("returns null for exact ANNOUNCE_SKIP token", () => {
      expect(normalizeReplyPayload({ text: "ANNOUNCE_SKIP" })).toBeNull();
    });

    it("returns null for ANNOUNCE_SKIP with surrounding whitespace", () => {
      expect(normalizeReplyPayload({ text: "  ANNOUNCE_SKIP  " })).toBeNull();
      expect(normalizeReplyPayload({ text: "\nANNOUNCE_SKIP\n" })).toBeNull();
    });

    it("does not suppress text that merely contains ANNOUNCE_SKIP", () => {
      const result = normalizeReplyPayload({ text: "The task is done. ANNOUNCE_SKIP" });
      // Not an exact-match — should still produce a payload (text delivery at caller's discretion)
      expect(result).not.toBeNull();
    });

    it("invokes onSkip callback with 'silent' reason for ANNOUNCE_SKIP", () => {
      const reasons: string[] = [];
      normalizeReplyPayload({ text: "ANNOUNCE_SKIP" }, { onSkip: (r) => reasons.push(r) });
      expect(reasons).toEqual(["silent"]);
    });

    it("preserves media-only payload when text is ANNOUNCE_SKIP", () => {
      // When there is attached media, the token should clear text but not drop the payload
      const result = normalizeReplyPayload({
        text: "ANNOUNCE_SKIP",
        mediaUrl: "https://example.com/img.png",
      });
      expect(result).not.toBeNull();
      expect(result?.text).toBe("");
      expect(result?.mediaUrl).toBe("https://example.com/img.png");
    });
  });

  describe("REPLY_SKIP suppression (#45084)", () => {
    it("returns null for exact REPLY_SKIP token", () => {
      expect(normalizeReplyPayload({ text: "REPLY_SKIP" })).toBeNull();
    });

    it("returns null for REPLY_SKIP with surrounding whitespace", () => {
      expect(normalizeReplyPayload({ text: "  REPLY_SKIP  " })).toBeNull();
    });

    it("invokes onSkip callback with 'silent' reason for REPLY_SKIP", () => {
      const reasons: string[] = [];
      normalizeReplyPayload({ text: "REPLY_SKIP" }, { onSkip: (r) => reasons.push(r) });
      expect(reasons).toEqual(["silent"]);
    });
  });
});

import { describe, expect, it } from "vitest";
import { resolveHeartbeatReplyPayload } from "./heartbeat-reply-payload.js";
import type { ReplyPayload } from "./types.js";

describe("resolveHeartbeatReplyPayload", () => {
  it("returns undefined when given undefined", () => {
    const result = resolveHeartbeatReplyPayload(undefined);
    expect(result).toBeUndefined();
  });

  it("returns the single payload when not an array", () => {
    const payload: ReplyPayload = { text: "hello" };
    const result = resolveHeartbeatReplyPayload(payload);
    expect(result).toBe(payload);
  });

  it("returns the first payload with content from array (backwards iteration)", () => {
    const payloads: ReplyPayload[] = [{ text: "first" }, { text: "second" }, { text: "third" }];
    const result = resolveHeartbeatReplyPayload(payloads);
    expect(result?.text).toBe("third");
  });

  it("skips empty payloads when iterating", () => {
    const payloads: ReplyPayload[] = [{ text: "first" }, {}, {}];
    const result = resolveHeartbeatReplyPayload(payloads);
    expect(result?.text).toBe("first");
  });

  it("finds payload with mediaUrl", () => {
    const payloads: ReplyPayload[] = [
      { text: "message" },
      { mediaUrl: "http://example.com/image.jpg" },
    ];
    const result = resolveHeartbeatReplyPayload(payloads);
    expect(result?.mediaUrl).toBe("http://example.com/image.jpg");
  });

  it("finds payload with mediaUrls", () => {
    const payloads: ReplyPayload[] = [
      { text: "message" },
      { mediaUrls: ["http://example.com/image1.jpg", "http://example.com/image2.jpg"] },
    ];
    const result = resolveHeartbeatReplyPayload(payloads);
    expect(result?.mediaUrls).toEqual([
      "http://example.com/image1.jpg",
      "http://example.com/image2.jpg",
    ]);
  });

  describe("BUG #19302: Error payload filtering", () => {
    // NOTE: The actual fix is in heartbeat-runner.ts (line 661) and web/auto-reply/heartbeat-runner.ts (line 176)
    // where isError payloads are filtered BEFORE calling resolveHeartbeatReplyPayload.
    // These tests verify that when error payloads are filtered, the correct reply is selected.
    // Integration tests in heartbeat-runner.ts files would verify the filter is actually applied in production.

    it("ignores error payloads when filtering is applied", () => {
      const payloads: ReplyPayload[] = [
        { text: "normal message" },
        { text: "⚠️ 🛠️ Exec: command failed", isError: true },
      ];
      // Filter out error payloads before passing to resolveHeartbeatReplyPayload
      const filtered = payloads.filter((p) => !p.isError);
      const result = resolveHeartbeatReplyPayload(filtered);
      expect(result?.text).toBe("normal message");
      expect(result?.isError).toBeUndefined();
    });

    it("returns undefined when only error payloads exist after filtering", () => {
      const payloads: ReplyPayload[] = [
        { text: "⚠️ 🛠️ Exec: error summary", isError: true },
        { text: "⚠️ 🛠️ Tool: tool error", isError: true },
      ];
      const filtered = payloads.filter((p) => !p.isError);
      const result = resolveHeartbeatReplyPayload(filtered);
      expect(result).toBeUndefined();
    });

    it("handles single error payload", () => {
      const payload: ReplyPayload = {
        text: "⚠️ 🛠️ Exec: command failed",
        isError: true,
      };
      // Single payloads don't get filtered
      const result = resolveHeartbeatReplyPayload(payload);
      expect(result?.isError).toBe(true);
    });

    it("filters error payloads from mixed array", () => {
      const payloads: ReplyPayload[] = [
        { text: "normal message 1" },
        { text: "⚠️ Tool error 1", isError: true },
        { text: "normal message 2" },
        { text: "⚠️ Tool error 2", isError: true },
      ];
      const filtered = payloads.filter((p) => !p.isError);
      const result = resolveHeartbeatReplyPayload(filtered);
      expect(result?.text).toBe("normal message 2");
      expect(result?.isError).toBeUndefined();
    });
  });
});

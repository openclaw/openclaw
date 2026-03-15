import { describe, expect, it } from "vitest";
import { resolveHeartbeatReplyPayload } from "./heartbeat-reply-payload.js";

/**
 * Regression tests for https://github.com/openclaw/openclaw/issues/19302
 *
 * `resolveHeartbeatReplyPayload` iterates the reply payload array backwards
 * and returns the last non-empty payload.  Before this fix, error payloads
 * (tool error summaries appended by `buildEmbeddedRunPayloads`) could shadow
 * the agent's real HEARTBEAT_OK response, causing spurious error messages
 * to be delivered to the channel.
 */
describe("resolveHeartbeatReplyPayload (#19302)", () => {
  it("returns undefined for undefined input", () => {
    expect(resolveHeartbeatReplyPayload(undefined)).toBeUndefined();
  });

  it("returns a single payload as-is", () => {
    const payload = { text: "hello" };
    expect(resolveHeartbeatReplyPayload(payload)).toBe(payload);
  });

  it("returns last non-empty payload from array", () => {
    const result = resolveHeartbeatReplyPayload([
      { text: "first" },
      { text: "" },
      { text: "last" },
    ]);
    expect(result).toEqual({ text: "last" });
  });

  it("skips isError payloads and returns earlier valid payload", () => {
    const result = resolveHeartbeatReplyPayload([
      { text: "HEARTBEAT_OK" },
      { text: "⚠️ 🛠️ Exec: command failed", isError: true },
    ]);
    expect(result).toEqual({ text: "HEARTBEAT_OK" });
  });

  it("skips multiple trailing isError payloads", () => {
    const result = resolveHeartbeatReplyPayload([
      { text: "All clear" },
      { text: "⚠️ Error 1", isError: true },
      { text: "⚠️ Error 2", isError: true },
    ]);
    expect(result).toEqual({ text: "All clear" });
  });

  it("returns undefined when all payloads are errors", () => {
    const result = resolveHeartbeatReplyPayload([
      { text: "⚠️ Error 1", isError: true },
      { text: "⚠️ Error 2", isError: true },
    ]);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(resolveHeartbeatReplyPayload([])).toBeUndefined();
  });

  it("returns media payload when present", () => {
    const result = resolveHeartbeatReplyPayload([{ mediaUrl: "https://example.com/image.png" }]);
    expect(result).toEqual({ mediaUrl: "https://example.com/image.png" });
  });

  it("skips error payloads and returns earlier media payload", () => {
    const result = resolveHeartbeatReplyPayload([
      { mediaUrls: ["https://example.com/a.png"] },
      { text: "⚠️ Upload failed", isError: true },
    ]);
    expect(result).toEqual({ mediaUrls: ["https://example.com/a.png"] });
  });

  it("does not filter isError on single (non-array) payload", () => {
    // Single payloads pass through as-is; only the array path filters.
    const payload = { text: "error text", isError: true as const };
    expect(resolveHeartbeatReplyPayload(payload)).toBe(payload);
  });
});

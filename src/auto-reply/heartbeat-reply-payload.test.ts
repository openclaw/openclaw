import { describe, expect, it } from "vitest";
import { resolveHeartbeatReplyPayload } from "./heartbeat-reply-payload.js";

describe("resolveHeartbeatReplyPayload", () => {
  it("returns undefined when the final payload is NO_REPLY", () => {
    const resolved = resolveHeartbeatReplyPayload([{ text: "Real content" }, { text: "NO_REPLY" }]);

    expect(resolved).toBeUndefined();
  });

  it("returns real content when NO_REPLY appears before the final payload", () => {
    const resolved = resolveHeartbeatReplyPayload([{ text: "NO_REPLY" }, { text: "Real content" }]);

    expect(resolved).toEqual({ text: "Real content" });
  });

  it("keeps last non-empty payload when no NO_REPLY exists", () => {
    const resolved = resolveHeartbeatReplyPayload([
      { text: "Let me check..." },
      { text: "Final alert" },
    ]);

    expect(resolved?.text).toBe("Final alert");
  });

  it("returns undefined for a single NO_REPLY payload", () => {
    const resolved = resolveHeartbeatReplyPayload({ text: "NO_REPLY" });
    expect(resolved).toBeUndefined();
  });
});

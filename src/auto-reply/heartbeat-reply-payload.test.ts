import { describe, expect, it } from "vitest";
import { resolveHeartbeatReplyPayload } from "./heartbeat-reply-payload.js";

describe("resolveHeartbeatReplyPayload", () => {
  it("prefers trailing NO_REPLY over earlier narration", () => {
    const resolved = resolveHeartbeatReplyPayload([
      { text: "Updating history..." },
      { text: "NO_REPLY" },
    ]);

    expect(resolved?.text).toBe("NO_REPLY");
  });

  it("keeps last non-empty payload when no NO_REPLY exists", () => {
    const resolved = resolveHeartbeatReplyPayload([
      { text: "Let me check..." },
      { text: "Final alert" },
    ]);

    expect(resolved?.text).toBe("Final alert");
  });
});

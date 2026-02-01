import { describe, expect, it } from "vitest";
import { buildAgentPeerSessionKey } from "./session-key.js";

describe("session-key", () => {
  it("preserves case for Signal group peer IDs", () => {
    const groupId = "mb+09B3md7Tnu0/bLVJaOJUxtc/Zig83EwXvh3zmu3w=";
    expect(
      buildAgentPeerSessionKey({
        agentId: "arjun",
        channel: "signal",
        peerKind: "group",
        peerId: groupId,
      }),
    ).toBe(`agent:arjun:signal:group:${groupId}`);
  });
});

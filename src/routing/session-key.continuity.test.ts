import { describe, it, expect } from "vitest";
import { buildAgentSessionKey } from "./resolve-route.js";

describe("Discord Session Key Continuity", () => {
  const agentId = "main";
  const channel = "discord";
  const accountId = "default";

  it("generates distinct keys for DM vs Channel (dmScope=main)", () => {
    // Scenario: Default config (dmScope=main)
    const dmKey = buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      peer: { kind: "direct", id: "user123" },
      dmScope: "main",
    });

    const groupKey = buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      peer: { kind: "channel", id: "channel456" },
      dmScope: "main",
    });

    expect(dmKey).toBe("agent:main:main");
    expect(groupKey).toBe("agent:main:discord:channel:channel456");
    expect(dmKey).not.toBe(groupKey);
  });

  it("generates distinct keys for DM vs Channel (dmScope=per-peer)", () => {
    // Scenario: Multi-user bot config
    const dmKey = buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      peer: { kind: "direct", id: "user123" },
      dmScope: "per-peer",
    });

    const groupKey = buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      peer: { kind: "channel", id: "channel456" },
      dmScope: "per-peer",
    });

    expect(dmKey).toBe("agent:main:direct:user123");
    expect(groupKey).toBe("agent:main:discord:channel:channel456");
    expect(dmKey).not.toBe(groupKey);
  });

  it("handles empty/invalid IDs safely without collision", () => {
    // If ID is missing, does it collide?
    const missingIdKey = buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      peer: { kind: "channel", id: "" }, // Empty string
      dmScope: "main",
    });

    expect(missingIdKey).toContain("unknown");

    // Should still be distinct from main
    expect(missingIdKey).not.toBe("agent:main:main");
  });
});

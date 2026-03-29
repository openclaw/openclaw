import { describe, it, expect } from "vitest";
import { buildAgentSessionKey } from "./resolve-route.js";

describe("Discord Session Key Continuity", () => {
  const agentId = "main";
  const channel = "discord";
  const accountId = "default";

  function buildDiscordSessionKey(params: {
    peer: { kind: "direct" | "channel"; id: string };
    dmScope?: "main" | "per-peer";
  }) {
    return buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      dmScope: params.dmScope ?? "main",
      peer: params.peer,
    });
  }

  function expectDistinctDmAndChannelKeys(params: {
    dmScope: "main" | "per-peer";
    expectedDmKey: string;
  }) {
    const dmKey = buildDiscordSessionKey({
      peer: { kind: "direct", id: "user123" },
      dmScope: params.dmScope,
    });

    const groupKey = buildDiscordSessionKey({
      peer: { kind: "channel", id: "channel456" },
    });

    expect(dmKey).toBe(params.expectedDmKey);
    expect(groupKey).toBe("agent:main:discord:channel:channel456");
    expect(dmKey).not.toBe(groupKey);
  }

  function expectUnknownChannelKeyCase(channelId: string) {
    const missingIdKey = buildDiscordSessionKey({
      peer: { kind: "channel", id: channelId },
    });

    expect(missingIdKey).toContain("unknown");
    expect(missingIdKey).not.toBe("agent:main:main");
  }

  it.each([
    {
      name: "keeps main-scoped DMs distinct from channel sessions",
      dmScope: "main" as const,
      expectedDmKey: "agent:main:main",
    },
    {
      name: "keeps per-peer DMs distinct from channel sessions",
      dmScope: "per-peer" as const,
      expectedDmKey: "agent:main:direct:user123",
    },
  ])("$name", ({ dmScope, expectedDmKey }) => {
    expectDistinctDmAndChannelKeys({ dmScope, expectedDmKey });
  });

  it.each(["", "   "] as const)("handles invalid channel id %j without collision", (channelId) => {
    expectUnknownChannelKeyCase(channelId);
  });
});

describe("Matrix Session Key Case Preservation", () => {
  it("preserves mixed-case room IDs in group/channel session keys", () => {
    const key = buildAgentSessionKey({
      agentId: "main",
      channel: "matrix",
      peer: { kind: "channel", id: "!IEjZDNPucuFvKLrAQC:matrix.example.com" },
    });
    expect(key).toBe("agent:main:matrix:channel:!IEjZDNPucuFvKLrAQC:matrix.example.com");
  });

  it("preserves mixed-case room IDs in group session keys", () => {
    const key = buildAgentSessionKey({
      agentId: "main",
      channel: "matrix",
      peer: { kind: "group", id: "!AbCdEfGh:matrix.example.com" },
    });
    expect(key).toBe("agent:main:matrix:group:!AbCdEfGh:matrix.example.com");
  });
});

describe("Non-Matrix providers still lowercase group/channel peer IDs", () => {
  it("lowercases Slack channel IDs", () => {
    const key = buildAgentSessionKey({
      agentId: "main",
      channel: "slack",
      peer: { kind: "channel", id: "C0ABWMM7TDW" },
    });
    expect(key).toBe("agent:main:slack:channel:c0abwmm7tdw");
  });

  it("lowercases Discord channel IDs", () => {
    const key = buildAgentSessionKey({
      agentId: "main",
      channel: "discord",
      peer: { kind: "channel", id: "Channel456" },
    });
    expect(key).toBe("agent:main:discord:channel:channel456");
  });

  it("lowercases Telegram group IDs", () => {
    const key = buildAgentSessionKey({
      agentId: "main",
      channel: "telegram",
      peer: { kind: "group", id: "MyGroup123" },
    });
    expect(key).toBe("agent:main:telegram:group:mygroup123");
  });
});

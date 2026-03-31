import { describe, expect, it } from "vitest";
import {
  deriveSessionChatType,
  getSubagentDepth,
  isAcpSessionKey,
  isCronRunSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveThreadParentSessionKey,
} from "./session-key-utils.js";

// ---------------------------------------------------------------------------
// parseAgentSessionKey
// ---------------------------------------------------------------------------
describe("parseAgentSessionKey", () => {
  it("parses a canonical agent session key", () => {
    const result = parseAgentSessionKey("agent:myAgent:direct:user123");
    expect(result).toEqual({ agentId: "myagent", rest: "direct:user123" });
  });

  it("normalizes to lowercase", () => {
    const result = parseAgentSessionKey("Agent:MyAgent:Direct:User123");
    expect(result).toEqual({ agentId: "myagent", rest: "direct:user123" });
  });

  it("trims surrounding whitespace", () => {
    const result = parseAgentSessionKey("  agent:bot:group:room  ");
    expect(result).toEqual({ agentId: "bot", rest: "group:room" });
  });

  it("joins rest parts with colon when there are more than 3 segments", () => {
    const result = parseAgentSessionKey("agent:bot:discord:guild-1:channel-2");
    expect(result).toEqual({
      agentId: "bot",
      rest: "discord:guild-1:channel-2",
    });
  });

  it("returns null for undefined input", () => {
    expect(parseAgentSessionKey(undefined)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseAgentSessionKey(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAgentSessionKey("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseAgentSessionKey("   ")).toBeNull();
  });

  it("returns null when fewer than 3 colon-separated parts", () => {
    expect(parseAgentSessionKey("agent:myAgent")).toBeNull();
  });

  it("returns null when prefix is not 'agent'", () => {
    expect(parseAgentSessionKey("session:myAgent:direct:user")).toBeNull();
  });

  it("returns null for single token", () => {
    expect(parseAgentSessionKey("agent")).toBeNull();
  });

  it("filters empty parts from consecutive colons", () => {
    // "agent::bot:rest" → split(":") = ["agent","","bot","rest"]
    // filter(Boolean) removes the empty string → ["agent","bot","rest"]
    // NOTE: The double-colon produces an empty segment, which the parser
    // silently drops via filter(Boolean). This means "agent::bot:rest" is
    // treated identically to "agent:bot:rest" — the empty segment does not
    // cause a parse failure. We test the current behavior here; whether
    // empty segments should be rejected is a separate design decision.
    const result = parseAgentSessionKey("agent::bot:rest");
    expect(result).toEqual({ agentId: "bot", rest: "rest" });
  });

  it("returns null when consecutive colons leave fewer than 3 parts", () => {
    // "agent::::" → all empty after split → only ["agent"] after filter
    expect(parseAgentSessionKey("agent::::")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveSessionChatType
// ---------------------------------------------------------------------------
describe("deriveSessionChatType", () => {
  it("returns 'unknown' for undefined", () => {
    expect(deriveSessionChatType(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for null", () => {
    expect(deriveSessionChatType(null)).toBe("unknown");
  });

  it("returns 'unknown' for empty string", () => {
    expect(deriveSessionChatType("")).toBe("unknown");
  });

  it("returns 'unknown' for whitespace-only string", () => {
    expect(deriveSessionChatType("   ")).toBe("unknown");
  });

  // group
  it("detects 'group' token in a plain key", () => {
    expect(deriveSessionChatType("telegram:group:12345")).toBe("group");
  });

  it("detects 'group' in an agent-scoped key", () => {
    expect(deriveSessionChatType("agent:bot1:telegram:group:12345")).toBe("group");
  });

  it("detects 'group' case-insensitively", () => {
    expect(deriveSessionChatType("TELEGRAM:GROUP:12345")).toBe("group");
  });

  // channel
  it("detects 'channel' token in a plain key", () => {
    expect(deriveSessionChatType("discord:channel:abc")).toBe("channel");
  });

  it("detects 'channel' in an agent-scoped key", () => {
    expect(deriveSessionChatType("agent:bot2:discord:channel:abc")).toBe("channel");
  });

  // direct / dm
  it("detects 'direct' token", () => {
    expect(deriveSessionChatType("telegram:direct:user1")).toBe("direct");
  });

  it("detects 'dm' token as direct", () => {
    expect(deriveSessionChatType("discord:dm:user2")).toBe("direct");
  });

  it("detects 'dm' in agent-scoped key", () => {
    expect(deriveSessionChatType("agent:bot:discord:dm:user2")).toBe("direct");
  });

  // priority: group > channel > direct
  it("prefers 'group' over 'channel' when both tokens present", () => {
    expect(deriveSessionChatType("slack:group:channel:room")).toBe("group");
  });

  it("prefers 'group' over 'direct' when both tokens present", () => {
    expect(deriveSessionChatType("slack:group:direct:room")).toBe("group");
  });

  it("prefers 'channel' over 'direct' when both tokens present", () => {
    expect(deriveSessionChatType("slack:channel:direct:room")).toBe("channel");
  });

  // Legacy Discord format
  it("detects legacy Discord guild:channel key as 'channel'", () => {
    expect(
      deriveSessionChatType("discord:acc123:guild-guild1:channel-chan1"),
    ).toBe("channel");
  });

  it("detects legacy Discord key without account segment", () => {
    expect(deriveSessionChatType("discord:guild-guild1:channel-chan1")).toBe(
      "channel",
    );
  });

  it("returns 'unknown' for unrecognized key structure", () => {
    expect(deriveSessionChatType("custom:something:else")).toBe("unknown");
  });

  it("returns 'unknown' for key with only agent prefix and no type token", () => {
    expect(deriveSessionChatType("agent:bot:custom:something")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// isCronRunSessionKey
// ---------------------------------------------------------------------------
describe("isCronRunSessionKey", () => {
  it("returns true for a valid cron run key", () => {
    expect(
      isCronRunSessionKey("agent:bot:cron:myjob:run:abc123"),
    ).toBe(true);
  });

  it("returns false for a cron key without run segment", () => {
    expect(isCronRunSessionKey("agent:bot:cron:myjob")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isCronRunSessionKey(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isCronRunSessionKey(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCronRunSessionKey("")).toBe(false);
  });

  it("returns false for non-agent key", () => {
    expect(isCronRunSessionKey("cron:myjob:run:abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCronSessionKey
// ---------------------------------------------------------------------------
describe("isCronSessionKey", () => {
  it("returns true when rest starts with cron:", () => {
    expect(isCronSessionKey("agent:bot:cron:daily")).toBe(true);
  });

  it("returns true for cron run keys", () => {
    expect(isCronSessionKey("agent:bot:cron:daily:run:abc")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isCronSessionKey("Agent:Bot:CRON:Daily")).toBe(true);
  });

  it("returns false when rest does not start with cron:", () => {
    expect(isCronSessionKey("agent:bot:direct:user")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isCronSessionKey(null)).toBe(false);
  });

  it("returns false for non-agent key", () => {
    expect(isCronSessionKey("cron:daily")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSubagentSessionKey
// ---------------------------------------------------------------------------
describe("isSubagentSessionKey", () => {
  it("returns true for top-level subagent: prefix", () => {
    expect(isSubagentSessionKey("subagent:child1")).toBe(true);
  });

  it("returns true for top-level subagent: prefix (case-insensitive)", () => {
    expect(isSubagentSessionKey("Subagent:Child1")).toBe(true);
  });

  it("returns true when agent-scoped rest starts with subagent:", () => {
    expect(
      isSubagentSessionKey("agent:bot:subagent:child1"),
    ).toBe(true);
  });

  it("returns false for non-subagent key", () => {
    expect(isSubagentSessionKey("agent:bot:direct:user")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSubagentSessionKey(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSubagentSessionKey(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSubagentSessionKey("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSubagentDepth
// ---------------------------------------------------------------------------
describe("getSubagentDepth", () => {
  it("returns 0 for null", () => {
    expect(getSubagentDepth(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(getSubagentDepth(undefined)).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(getSubagentDepth("")).toBe(0);
  });

  it("returns 0 when there is no :subagent: marker", () => {
    expect(getSubagentDepth("agent:bot:direct:user")).toBe(0);
  });

  it("returns 1 for a single subagent nesting", () => {
    expect(getSubagentDepth("agent:bot:subagent:child")).toBe(1);
  });

  it("returns 2 for doubly-nested subagent", () => {
    expect(
      getSubagentDepth("agent:bot:subagent:child1:subagent:child2"),
    ).toBe(2);
  });

  it("is case-insensitive", () => {
    expect(getSubagentDepth("Agent:Bot:Subagent:Child")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isAcpSessionKey
// ---------------------------------------------------------------------------
describe("isAcpSessionKey", () => {
  it("returns true for top-level acp: prefix", () => {
    expect(isAcpSessionKey("acp:session123")).toBe(true);
  });

  it("returns true for top-level acp: prefix (case-insensitive)", () => {
    expect(isAcpSessionKey("ACP:Session123")).toBe(true);
  });

  it("returns true when agent-scoped rest starts with acp:", () => {
    expect(isAcpSessionKey("agent:bot:acp:session123")).toBe(true);
  });

  it("returns false for non-acp key", () => {
    expect(isAcpSessionKey("agent:bot:direct:user")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAcpSessionKey(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAcpSessionKey(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAcpSessionKey("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveThreadParentSessionKey
// ---------------------------------------------------------------------------
describe("resolveThreadParentSessionKey", () => {
  it("returns null for null", () => {
    expect(resolveThreadParentSessionKey(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(resolveThreadParentSessionKey(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(resolveThreadParentSessionKey("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(resolveThreadParentSessionKey("   ")).toBeNull();
  });

  it("returns null when no thread/topic marker present", () => {
    expect(resolveThreadParentSessionKey("agent:bot:direct:user")).toBeNull();
  });

  it("extracts parent before :thread: marker", () => {
    expect(
      resolveThreadParentSessionKey("agent:bot:group:room1:thread:t1"),
    ).toBe("agent:bot:group:room1");
  });

  it("extracts parent before :topic: marker", () => {
    expect(
      resolveThreadParentSessionKey("agent:bot:group:room1:topic:t1"),
    ).toBe("agent:bot:group:room1");
  });

  it("uses the last marker when multiple are present", () => {
    // :topic: at index 25, :thread: at index 35 — should use the later one
    const key = "agent:bot:group:room1:topic:t1:thread:t2";
    const result = resolveThreadParentSessionKey(key);
    expect(result).toBe("agent:bot:group:room1:topic:t1");
  });

  it("is case-insensitive for markers", () => {
    expect(
      resolveThreadParentSessionKey("Agent:Bot:Group:Room1:THREAD:T1"),
    ).toBe("Agent:Bot:Group:Room1");
  });

  it("preserves original casing in the returned parent", () => {
    const result = resolveThreadParentSessionKey(
      "Agent:Bot:Group:Room:Thread:T1",
    );
    expect(result).toBe("Agent:Bot:Group:Room");
  });

  it("returns null when marker is at position 0", () => {
    expect(resolveThreadParentSessionKey(":thread:something")).toBeNull();
  });

  // The idx<=0 guard is effectively dead code: the input is already trimmed
  // before the marker search, so a leading `:thread:` always appears at
  // index 0, not after whitespace. This test exercises that idx<=0 path.
  it("returns null when marker appears at index 0 after input trim", () => {
    expect(resolveThreadParentSessionKey("   :thread:something")).toBeNull();
  });
});

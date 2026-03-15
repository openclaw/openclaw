import { describe, expect, it } from "vitest";
import {
  deriveSessionChatType,
  extractUserIdFromSessionKey,
  getSubagentDepth,
  isCronSessionKey,
} from "../sessions/session-key-utils.js";
import {
  classifySessionKeyShape,
  isValidAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "./session-key.js";

describe("classifySessionKeyShape", () => {
  it("classifies empty keys as missing", () => {
    expect(classifySessionKeyShape(undefined)).toBe("missing");
    expect(classifySessionKeyShape("   ")).toBe("missing");
  });

  it("classifies valid agent keys", () => {
    expect(classifySessionKeyShape("agent:main:main")).toBe("agent");
    expect(classifySessionKeyShape("agent:research:subagent:worker")).toBe("agent");
  });

  it("classifies malformed agent keys", () => {
    expect(classifySessionKeyShape("agent::broken")).toBe("malformed_agent");
    expect(classifySessionKeyShape("agent:main")).toBe("malformed_agent");
  });

  it("treats non-agent legacy or alias keys as non-malformed", () => {
    expect(classifySessionKeyShape("main")).toBe("legacy_or_alias");
    expect(classifySessionKeyShape("custom-main")).toBe("legacy_or_alias");
    expect(classifySessionKeyShape("subagent:worker")).toBe("legacy_or_alias");
  });
});

describe("session key backward compatibility", () => {
  it("classifies legacy :dm: session keys as valid agent keys", () => {
    // Legacy session keys use :dm: instead of :direct:
    // Both should be recognized as valid agent keys
    expect(classifySessionKeyShape("agent:main:telegram:dm:123456")).toBe("agent");
    expect(classifySessionKeyShape("agent:main:whatsapp:dm:+15551234567")).toBe("agent");
    expect(classifySessionKeyShape("agent:main:discord:dm:user123")).toBe("agent");
  });

  it("classifies new :direct: session keys as valid agent keys", () => {
    expect(classifySessionKeyShape("agent:main:telegram:direct:123456")).toBe("agent");
    expect(classifySessionKeyShape("agent:main:whatsapp:direct:+15551234567")).toBe("agent");
    expect(classifySessionKeyShape("agent:main:discord:direct:user123")).toBe("agent");
  });
});

describe("getSubagentDepth", () => {
  it("returns 0 for non-subagent session keys", () => {
    expect(getSubagentDepth("agent:main:main")).toBe(0);
    expect(getSubagentDepth("main")).toBe(0);
    expect(getSubagentDepth(undefined)).toBe(0);
  });

  it("returns 2 for nested subagent session keys", () => {
    expect(getSubagentDepth("agent:main:subagent:parent:subagent:child")).toBe(2);
  });
});

describe("isCronSessionKey", () => {
  it("matches base and run cron agent session keys", () => {
    expect(isCronSessionKey("agent:main:cron:job-1")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:job-1:run:run-1")).toBe(true);
  });

  it("does not match non-cron sessions", () => {
    expect(isCronSessionKey("agent:main:main")).toBe(false);
    expect(isCronSessionKey("agent:main:subagent:worker")).toBe(false);
    expect(isCronSessionKey("cron:job-1")).toBe(false);
    expect(isCronSessionKey(undefined)).toBe(false);
  });
});

describe("deriveSessionChatType", () => {
  it("detects canonical direct/group/channel session keys", () => {
    expect(deriveSessionChatType("agent:main:discord:direct:user1")).toBe("direct");
    expect(deriveSessionChatType("agent:main:telegram:group:g1")).toBe("group");
    expect(deriveSessionChatType("agent:main:discord:channel:c1")).toBe("channel");
  });

  it("detects legacy direct markers", () => {
    expect(deriveSessionChatType("agent:main:telegram:dm:123456")).toBe("direct");
    expect(deriveSessionChatType("telegram:dm:123456")).toBe("direct");
  });

  it("detects legacy discord guild channel keys", () => {
    expect(deriveSessionChatType("discord:acc-1:guild-123:channel-456")).toBe("channel");
  });

  it("returns unknown for main or malformed session keys", () => {
    expect(deriveSessionChatType("agent:main:main")).toBe("unknown");
    expect(deriveSessionChatType("agent:main")).toBe("unknown");
    expect(deriveSessionChatType("")).toBe("unknown");
  });
});

describe("session key canonicalization", () => {
  it("parses agent keys case-insensitively and returns lowercase tokens", () => {
    expect(parseAgentSessionKey("AGENT:Main:Hook:Webhook:42")).toEqual({
      agentId: "main",
      rest: "hook:webhook:42",
    });
  });

  it("does not double-prefix already-qualified agent keys", () => {
    expect(
      toAgentStoreSessionKey({
        agentId: "main",
        requestKey: "agent:main:main",
      }),
    ).toBe("agent:main:main");
  });
});

describe("isValidAgentId", () => {
  it("accepts valid agent ids", () => {
    expect(isValidAgentId("main")).toBe(true);
    expect(isValidAgentId("my-research_agent01")).toBe(true);
  });

  it("rejects malformed agent ids", () => {
    expect(isValidAgentId("")).toBe(false);
    expect(isValidAgentId("Agent not found: xyz")).toBe(false);
    expect(isValidAgentId("../../../etc/passwd")).toBe(false);
    expect(isValidAgentId("a".repeat(65))).toBe(false);
  });
});

describe("extractUserIdFromSessionKey", () => {
  it("extracts userId from direct session keys", () => {
    expect(extractUserIdFromSessionKey("agent:main:direct:user123")).toBe("user123");
    expect(extractUserIdFromSessionKey("agent:main:telegram:direct:user123")).toBe("user123");
    expect(extractUserIdFromSessionKey("agent:main:discord:direct:456789")).toBe("456789");
  });

  it("extracts userId from session keys with channel prefix", () => {
    expect(extractUserIdFromSessionKey("agent:main:whatsapp:account1:direct:+15551234567")).toBe(
      "+15551234567",
    );
    expect(extractUserIdFromSessionKey("agent:main:telegram:account1:direct:987654")).toBe(
      "987654",
    );
  });

  it("returns null for non-direct session keys", () => {
    expect(extractUserIdFromSessionKey("agent:main:main")).toBeNull();
    expect(extractUserIdFromSessionKey("agent:main:telegram:group:g1")).toBeNull();
    expect(extractUserIdFromSessionKey("agent:main:discord:channel:c1")).toBeNull();
  });

  it("returns null for session keys without user after direct", () => {
    expect(extractUserIdFromSessionKey("agent:main:direct")).toBeNull();
    expect(extractUserIdFromSessionKey("agent:main:telegram:direct")).toBeNull();
  });

  it("returns null for invalid or empty session keys", () => {
    expect(extractUserIdFromSessionKey(undefined)).toBeNull();
    expect(extractUserIdFromSessionKey("")).toBeNull();
    expect(extractUserIdFromSessionKey("   ")).toBeNull();
  });

  it("does not extract reserved words as userId", () => {
    expect(extractUserIdFromSessionKey("agent:main:direct:group")).toBeNull();
    expect(extractUserIdFromSessionKey("agent:main:direct:channel")).toBeNull();
    expect(extractUserIdFromSessionKey("agent:main:direct:dm")).toBeNull();
    expect(extractUserIdFromSessionKey("agent:main:direct:cron")).toBeNull();
    expect(extractUserIdFromSessionKey("agent:main:direct:subagent")).toBeNull();
    expect(extractUserIdFromSessionKey("agent:main:direct:acp")).toBeNull();
  });
});

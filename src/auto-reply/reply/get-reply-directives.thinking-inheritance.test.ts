import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { ThinkLevel } from "../thinking.js";
import { resolveParentSessionKeyCandidate } from "./model-selection.js";

const makeEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  ...overrides,
});

function resolveThinkLevelWithParent(params: {
  directiveThinkLevel?: ThinkLevel;
  sessionThinkLevel?: ThinkLevel;
  sessionKey?: string;
  parentSessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  agentDefault?: ThinkLevel;
}): ThinkLevel | undefined {
  const parentKey = resolveParentSessionKeyCandidate({
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
  });
  const parentThinkLevel = (() => {
    if (!parentKey || !params.sessionStore) {
      return undefined;
    }
    return params.sessionStore[parentKey]?.thinkingLevel as ThinkLevel | undefined;
  })();

  return (
    params.directiveThinkLevel ??
    params.sessionThinkLevel ??
    parentThinkLevel ??
    params.agentDefault
  );
}

describe("thinking level parent session inheritance", () => {
  it("falls through to agentCfg default when no parent exists", () => {
    const result = resolveThinkLevelWithParent({
      sessionKey: "agent:main:slack:group:G123",
      sessionStore: {},
      agentDefault: "low",
    });
    expect(result).toBe("low");
  });

  it("inherits parent thinking level via explicit parentSessionKey", () => {
    const parentKey = "agent:main:slack:group:G123";
    const sessionKey = "agent:main:slack:group:G123:thread:abc";
    const sessionStore: Record<string, SessionEntry> = {
      [parentKey]: makeEntry({ thinkingLevel: "xhigh" }),
    };

    const result = resolveThinkLevelWithParent({
      sessionKey,
      parentSessionKey: parentKey,
      sessionStore,
      agentDefault: "off",
    });
    expect(result).toBe("xhigh");
  });

  it("own session thinking level takes precedence over parent", () => {
    const parentKey = "agent:main:slack:group:G123";
    const sessionKey = "agent:main:slack:group:G123:thread:abc";
    const sessionStore: Record<string, SessionEntry> = {
      [parentKey]: makeEntry({ thinkingLevel: "xhigh" }),
    };

    const result = resolveThinkLevelWithParent({
      sessionKey,
      parentSessionKey: parentKey,
      sessionStore,
      sessionThinkLevel: "low",
      agentDefault: "off",
    });
    expect(result).toBe("low");
  });

  it("inline directive takes precedence over everything", () => {
    const parentKey = "agent:main:slack:group:G123";
    const sessionKey = "agent:main:slack:group:G123:thread:abc";
    const sessionStore: Record<string, SessionEntry> = {
      [parentKey]: makeEntry({ thinkingLevel: "xhigh" }),
    };

    const result = resolveThinkLevelWithParent({
      directiveThinkLevel: "minimal",
      sessionKey,
      parentSessionKey: parentKey,
      sessionStore,
      sessionThinkLevel: "low",
      agentDefault: "off",
    });
    expect(result).toBe("minimal");
  });

  it("derives parent key from thread session suffix", () => {
    const parentKey = "agent:main:slack:group:G123";
    const sessionKey = "agent:main:slack:group:G123:thread:abc";
    const sessionStore: Record<string, SessionEntry> = {
      [parentKey]: makeEntry({ thinkingLevel: "high" }),
    };

    const result = resolveThinkLevelWithParent({
      sessionKey,
      sessionStore,
      agentDefault: "off",
    });
    expect(result).toBe("high");
  });

  it("returns undefined when no level is set anywhere", () => {
    const result = resolveThinkLevelWithParent({
      sessionKey: "agent:main:slack:group:G123",
      sessionStore: {},
    });
    expect(result).toBeUndefined();
  });

  it("skips parent lookup when sessionStore is not provided", () => {
    const parentKey = "agent:main:slack:group:G123";
    const sessionKey = "agent:main:slack:group:G123:thread:abc";

    const result = resolveThinkLevelWithParent({
      sessionKey,
      parentSessionKey: parentKey,
      // no sessionStore
      agentDefault: "medium",
    });
    expect(result).toBe("medium");
  });
});

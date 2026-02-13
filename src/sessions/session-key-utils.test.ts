import { describe, expect, it } from "vitest";
import {
  isGroupChannelSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "./session-key-utils.js";

describe("parseAgentSessionKey", () => {
  it("parses valid agent session keys", () => {
    expect(parseAgentSessionKey("agent:main:telegram:dm:123")).toEqual({
      agentId: "main",
      rest: "telegram:dm:123",
    });
    expect(parseAgentSessionKey("agent:reviewer:subagent:foo")).toEqual({
      agentId: "reviewer",
      rest: "subagent:foo",
    });
  });

  it("returns null for invalid keys", () => {
    expect(parseAgentSessionKey("")).toBeNull();
    expect(parseAgentSessionKey("main")).toBeNull();
    expect(parseAgentSessionKey("agent:main")).toBeNull();
    expect(parseAgentSessionKey(null)).toBeNull();
    expect(parseAgentSessionKey(undefined)).toBeNull();
  });
});

describe("isSubagentSessionKey", () => {
  it("detects subagent keys", () => {
    expect(isSubagentSessionKey("subagent:foo")).toBe(true);
    expect(isSubagentSessionKey("agent:main:subagent:foo")).toBe(true);
    expect(isSubagentSessionKey("SUBAGENT:bar")).toBe(true);
  });

  it("rejects non-subagent keys", () => {
    expect(isSubagentSessionKey("main")).toBe(false);
    expect(isSubagentSessionKey("agent:main:telegram:dm:123")).toBe(false);
    expect(isSubagentSessionKey("")).toBe(false);
  });
});

describe("isGroupChannelSessionKey", () => {
  it("detects group session keys", () => {
    expect(isGroupChannelSessionKey("telegram:group:abc")).toBe(true);
    expect(isGroupChannelSessionKey("discord:group:server123")).toBe(true);
    expect(isGroupChannelSessionKey("agent:main:telegram:group:abc")).toBe(true);
    expect(isGroupChannelSessionKey("agent:main:discord:channel:general")).toBe(true);
  });

  it("detects channel session keys", () => {
    expect(isGroupChannelSessionKey("slack:channel:general")).toBe(true);
    expect(isGroupChannelSessionKey("agent:main:slack:channel:random")).toBe(true);
  });

  it("rejects DM and main session keys", () => {
    expect(isGroupChannelSessionKey("main")).toBe(false);
    expect(isGroupChannelSessionKey("agent:main:main")).toBe(false);
    expect(isGroupChannelSessionKey("telegram:dm:123")).toBe(false);
    expect(isGroupChannelSessionKey("agent:main:telegram:dm:456")).toBe(false);
    expect(isGroupChannelSessionKey("subagent:foo")).toBe(false);
    expect(isGroupChannelSessionKey("")).toBe(false);
    expect(isGroupChannelSessionKey(null)).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { getThreadRegistry, resetThreadRegistry } from "../../config/thread-registry.js";
import { resolveSessionKeyWithBinding, resolveThreadSessionKeys } from "../session-key.js";

describe("resolveSessionKeyWithBinding", () => {
  afterEach(() => {
    resetThreadRegistry();
  });

  const base = "agent:main:slack:group:C123";

  it("returns base key when no threadId is provided", () => {
    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      channel: "slack",
      threadId: null,
    });
    expect(result.sessionKey).toBe(base);
    expect(result.boundSessions).toBeUndefined();
  });

  it("returns base key when threadId is empty string", () => {
    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      channel: "slack",
      threadId: "  ",
    });
    expect(result.sessionKey).toBe(base);
  });

  it("returns base key when channel is not provided", () => {
    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      threadId: "1234567890.123",
    });
    expect(result.sessionKey).toBe(base);
  });

  it("returns bound session when registry has a match", () => {
    const registry = getThreadRegistry();
    registry.bind("agent:dev:subagent:abc", "slack:T1:1234567890.123");

    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      channel: "slack",
      accountId: "T1",
      threadId: "1234567890.123",
    });

    expect(result.sessionKey).toBe("agent:dev:subagent:abc");
    expect(result.boundSessions).toEqual(["agent:dev:subagent:abc"]);
    expect(result.parentSessionKey).toBeUndefined();
  });

  it("returns all bound sessions when multiple exist", () => {
    const registry = getThreadRegistry();
    registry.bind("session-a", "slack:T1:ts1");
    registry.bind("session-b", "slack:T1:ts1");

    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      channel: "slack",
      accountId: "T1",
      threadId: "ts1",
    });

    expect(result.boundSessions).toHaveLength(2);
    expect(new Set(result.boundSessions)).toEqual(new Set(["session-a", "session-b"]));
    // Primary is first
    expect(result.sessionKey).toBe(result.boundSessions![0]);
  });

  it("falls back to suffix key when registry has no match", () => {
    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      channel: "slack",
      accountId: "T1",
      threadId: "unbound-thread",
    });

    expect(result.sessionKey).toBe(`${base}:thread:unbound-thread`);
    expect(result.boundSessions).toBeUndefined();
  });

  it("passes parentSessionKey through on fallback", () => {
    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      channel: "slack",
      accountId: "T1",
      threadId: "unbound-thread",
      parentSessionKey: "agent:main:main",
    });

    expect(result.sessionKey).toBe(`${base}:thread:unbound-thread`);
    expect(result.parentSessionKey).toBe("agent:main:main");
  });

  it("respects useSuffix=false on fallback", () => {
    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      channel: "slack",
      threadId: "ts1",
      useSuffix: false,
    });

    expect(result.sessionKey).toBe(base);
  });

  it("registry match takes priority over useSuffix", () => {
    const registry = getThreadRegistry();
    registry.bind("bound-session", "slack::ts1");

    const result = resolveSessionKeyWithBinding({
      baseSessionKey: base,
      channel: "slack",
      threadId: "ts1",
      useSuffix: false,
    });

    // Registry match wins, regardless of useSuffix
    expect(result.sessionKey).toBe("bound-session");
    expect(result.boundSessions).toEqual(["bound-session"]);
  });
});

describe("resolveThreadSessionKeys", () => {
  it("appends thread suffix with threadId", () => {
    const result = resolveThreadSessionKeys({
      baseSessionKey: "agent:main:slack:group:C1",
      threadId: "1234567890.123456",
    });
    expect(result.sessionKey).toBe("agent:main:slack:group:C1:thread:1234567890.123456");
  });

  it("returns base key when threadId is empty", () => {
    const result = resolveThreadSessionKeys({
      baseSessionKey: "agent:main:main",
      threadId: "",
    });
    expect(result.sessionKey).toBe("agent:main:main");
    expect(result.parentSessionKey).toBeUndefined();
  });

  it("returns base key when threadId is null", () => {
    const result = resolveThreadSessionKeys({
      baseSessionKey: "agent:main:main",
      threadId: null,
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("normalizes threadId to lowercase", () => {
    const result = resolveThreadSessionKeys({
      baseSessionKey: "agent:main:main",
      threadId: "ABC123",
    });
    expect(result.sessionKey).toBe("agent:main:main:thread:abc123");
  });

  it("passes through parentSessionKey", () => {
    const result = resolveThreadSessionKeys({
      baseSessionKey: "agent:main:slack:group:C1",
      threadId: "ts1",
      parentSessionKey: "agent:main:main",
    });
    expect(result.parentSessionKey).toBe("agent:main:main");
  });

  it("skips suffix when useSuffix=false", () => {
    const result = resolveThreadSessionKeys({
      baseSessionKey: "agent:main:main",
      threadId: "ts1",
      useSuffix: false,
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });
});

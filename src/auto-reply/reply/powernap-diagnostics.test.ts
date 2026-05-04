import { describe, expect, it } from "vitest";
import { parsePowernapArgs, shouldResetSession } from "./powernap-diagnostics.js";

describe("parsePowernapArgs", () => {
  it("returns defaults when no args", () => {
    const result = parsePowernapArgs(undefined);
    expect(result.mode).toBe("all");
    expect(result.isStats).toBe(false);
    // intent is auto-detected (deploy or glitch based on process.uptime)
    expect(["deploy", "glitch"]).toContain(result.intent);
  });

  it("returns defaults for empty string", () => {
    const result = parsePowernapArgs("");
    expect(result.mode).toBe("all");
    expect(result.isStats).toBe(false);
  });

  it("parses 'stats' arg", () => {
    const result = parsePowernapArgs("stats");
    expect(result.isStats).toBe(true);
  });

  it("parses 'clean' arg", () => {
    const result = parsePowernapArgs("clean");
    expect(result.intent).toBe("clean");
    expect(result.mode).toBe("all");
    expect(result.isStats).toBe(false);
  });

  it("parses 'diagnose' arg", () => {
    const result = parsePowernapArgs("diagnose");
    expect(result.intent).toBe("glitch");
    expect(result.mode).toBe("all");
  });

  it("parses 'groups' arg", () => {
    const result = parsePowernapArgs("groups");
    expect(result.mode).toBe("groups");
  });

  it("parses 'stale' arg", () => {
    const result = parsePowernapArgs("stale");
    expect(result.mode).toBe("stale");
  });

  it("handles unknown args gracefully", () => {
    const result = parsePowernapArgs("foobar");
    expect(result.mode).toBe("all");
    expect(result.isStats).toBe(false);
  });

  it("is case insensitive", () => {
    expect(parsePowernapArgs("CLEAN").intent).toBe("clean");
    expect(parsePowernapArgs("Groups").mode).toBe("groups");
    expect(parsePowernapArgs("STATS").isStats).toBe(true);
  });
});

describe("shouldResetSession", () => {
  it("never resets cron sessions regardless of mode", () => {
    expect(shouldResetSession("agent:main:cron:daily:run:abc", "all")).toBe(false);
    expect(shouldResetSession("agent:main:cron:daily:run:abc", "groups")).toBe(false);
    expect(shouldResetSession("agent:main:cron:daily:run:abc", "stale")).toBe(false);
  });

  it("mode=all resets everything except cron", () => {
    expect(shouldResetSession("agent:main:main", "all")).toBe(true);
    expect(shouldResetSession("agent:main:whatsapp:group:123", "all")).toBe(true);
    expect(shouldResetSession("agent:main:whatsapp:direct:456", "all")).toBe(true);
  });

  it("mode=groups resets only group sessions", () => {
    expect(shouldResetSession("agent:main:whatsapp:group:123", "groups")).toBe(true);
    expect(shouldResetSession("agent:main:telegram:group:456", "groups")).toBe(true);
    expect(shouldResetSession("agent:main:main", "groups")).toBe(false);
    expect(shouldResetSession("agent:main:whatsapp:direct:789", "groups")).toBe(false);
  });

  it("mode=stale resets high-token sessions", () => {
    expect(
      shouldResetSession("agent:main:main", "stale", {
        totalTokens: 80000,
        contextTokens: 100000,
        updatedAt: Date.now(),
      }),
    ).toBe(true);
  });

  it("mode=stale resets inactive sessions (>24h)", () => {
    const over24hAgo = Date.now() - 25 * 60 * 60 * 1000;
    expect(
      shouldResetSession("agent:main:main", "stale", {
        totalTokens: 100,
        contextTokens: 100000,
        updatedAt: over24hAgo,
      }),
    ).toBe(true);
  });

  it("mode=stale skips active low-token sessions", () => {
    expect(
      shouldResetSession("agent:main:main", "stale", {
        totalTokens: 100,
        contextTokens: 100000,
        updatedAt: Date.now(),
      }),
    ).toBe(false);
  });

  it("mode=stale returns false without entry data", () => {
    expect(shouldResetSession("agent:main:main", "stale")).toBe(false);
  });

  it("mode=here always returns false (handled by /powernaphere)", () => {
    expect(shouldResetSession("agent:main:main", "here")).toBe(false);
  });
});

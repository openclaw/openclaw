import { describe, expect, it } from "vitest";
import { resolveAgentLane, resolveAgentLaneConcurrency } from "./agent-limits.js";
import type { OpenClawConfig } from "./types.js";

describe("resolveAgentLane", () => {
  it("returns undefined when no config", () => {
    expect(resolveAgentLane(undefined, "main")).toBeUndefined();
  });

  it("returns undefined when no agents.list", () => {
    const cfg = { agents: { defaults: {} } } as OpenClawConfig;
    expect(resolveAgentLane(cfg, "main")).toBeUndefined();
  });

  it("returns undefined when agent has no lane", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a" }] },
    } as OpenClawConfig;
    expect(resolveAgentLane(cfg, "bot-a")).toBeUndefined();
  });

  it("returns the configured lane", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a", lane: "bot-a-lane" }] },
    } as unknown as OpenClawConfig;
    expect(resolveAgentLane(cfg, "bot-a")).toBe("bot-a-lane");
  });

  it("trims whitespace from lane", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a", lane: "  my-lane  " }] },
    } as unknown as OpenClawConfig;
    expect(resolveAgentLane(cfg, "bot-a")).toBe("my-lane");
  });

  it("returns undefined for empty-string lane", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a", lane: "   " }] },
    } as unknown as OpenClawConfig;
    expect(resolveAgentLane(cfg, "bot-a")).toBeUndefined();
  });

  it("returns undefined when agentId does not match", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a", lane: "a-lane" }] },
    } as unknown as OpenClawConfig;
    expect(resolveAgentLane(cfg, "bot-b")).toBeUndefined();
  });
});

describe("resolveAgentLaneConcurrency", () => {
  it("returns undefined when no config", () => {
    expect(resolveAgentLaneConcurrency(undefined, "main")).toBeUndefined();
  });

  it("returns the configured concurrency", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a", laneConcurrency: 10 }] },
    } as unknown as OpenClawConfig;
    expect(resolveAgentLaneConcurrency(cfg, "bot-a")).toBe(10);
  });

  it("floors fractional values", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a", laneConcurrency: 3.7 }] },
    } as unknown as OpenClawConfig;
    expect(resolveAgentLaneConcurrency(cfg, "bot-a")).toBe(3);
  });

  it("clamps to minimum of 1", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a", laneConcurrency: 0 }] },
    } as unknown as OpenClawConfig;
    // 0 is not positive so zod rejects it, but if it somehow reaches the
    // resolver, Math.max(1, ...) ensures at least 1.
    expect(resolveAgentLaneConcurrency(cfg, "bot-a")).toBe(1);
  });

  it("returns undefined when agent has no laneConcurrency", () => {
    const cfg = {
      agents: { list: [{ id: "bot-a", lane: "a-lane" }] },
    } as unknown as OpenClawConfig;
    expect(resolveAgentLaneConcurrency(cfg, "bot-a")).toBeUndefined();
  });
});

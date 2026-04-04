import { describe, expect, it } from "vitest";
import {
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
} from "./agent-limits.js";

describe("DEFAULT_AGENT_MAX_CONCURRENT", () => {
  it("has sensible default value", () => {
    expect(DEFAULT_AGENT_MAX_CONCURRENT).toBe(4);
  });
});

describe("DEFAULT_SUBAGENT_MAX_CONCURRENT", () => {
  it("has sensible default value", () => {
    expect(DEFAULT_SUBAGENT_MAX_CONCURRENT).toBe(8);
  });
});

describe("resolveAgentMaxConcurrent", () => {
  it("returns configured value when valid", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 10 } } } as any;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(10);
  });

  it("floors decimal values", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 5.9 } } } as any;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(5);
  });

  it("returns minimum of 1 for values < 1", () => {
    const cfg1 = { agents: { defaults: { maxConcurrent: 0.5 } } } as any;
    const cfg2 = { agents: { defaults: { maxConcurrent: 0 } } } as any;
    const cfg3 = { agents: { defaults: { maxConcurrent: -5 } } } as any;
    expect(resolveAgentMaxConcurrent(cfg1)).toBe(1);
    expect(resolveAgentMaxConcurrent(cfg2)).toBe(1);
    expect(resolveAgentMaxConcurrent(cfg3)).toBe(1);
  });

  it("returns default for undefined config", () => {
    expect(resolveAgentMaxConcurrent(undefined)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
  });

  it("returns default for missing maxConcurrent", () => {
    const cfg = { agents: { defaults: {} } } as any;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
  });

  it("returns default for non-number maxConcurrent", () => {
    const cfg = { agents: { defaults: { maxConcurrent: "5" } } } as any;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
  });
});

describe("resolveSubagentMaxConcurrent", () => {
  it("returns configured value when valid", () => {
    const cfg = { agents: { defaults: { subagents: { maxConcurrent: 15 } } } } as any;
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(15);
  });

  it("floors decimal values", () => {
    const cfg = { agents: { defaults: { subagents: { maxConcurrent: 3.7 } } } } as any;
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(3);
  });

  it("returns minimum of 1 for values < 1", () => {
    const cfg = { agents: { defaults: { subagents: { maxConcurrent: 0.2 } } } } as any;
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
  });

  it("returns default for undefined config", () => {
    expect(resolveSubagentMaxConcurrent(undefined)).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });

  it("returns default for missing subagents config", () => {
    const cfg = { agents: { defaults: {} } } as any;
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });
});

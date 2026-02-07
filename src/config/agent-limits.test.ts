import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
} from "./agent-limits.js";
import type { OpenClawConfig } from "./types.js";

describe("DEFAULT constants", () => {
  it("DEFAULT_AGENT_MAX_CONCURRENT is 4", () => {
    expect(DEFAULT_AGENT_MAX_CONCURRENT).toBe(4);
  });

  it("DEFAULT_SUBAGENT_MAX_CONCURRENT is 8", () => {
    expect(DEFAULT_SUBAGENT_MAX_CONCURRENT).toBe(8);
  });
});

describe("resolveAgentMaxConcurrent", () => {
  it("returns default when config is undefined", () => {
    expect(resolveAgentMaxConcurrent()).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
  });

  it("returns default when agents.defaults is missing", () => {
    expect(resolveAgentMaxConcurrent({} as OpenClawConfig)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
  });

  it("returns configured value", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 10 } } } as OpenClawConfig;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(10);
  });

  it("floors fractional values", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 3.9 } } } as OpenClawConfig;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(3);
  });

  it("clamps to minimum of 1", () => {
    const cfg = { agents: { defaults: { maxConcurrent: 0 } } } as OpenClawConfig;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
  });

  it("clamps negative values to 1", () => {
    const cfg = { agents: { defaults: { maxConcurrent: -5 } } } as OpenClawConfig;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
  });

  it("returns default for NaN", () => {
    const cfg = { agents: { defaults: { maxConcurrent: Number.NaN } } } as OpenClawConfig;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
  });

  it("returns default for Infinity", () => {
    const cfg = {
      agents: { defaults: { maxConcurrent: Number.POSITIVE_INFINITY } },
    } as OpenClawConfig;
    expect(resolveAgentMaxConcurrent(cfg)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
  });
});

describe("resolveSubagentMaxConcurrent", () => {
  it("returns default when config is undefined", () => {
    expect(resolveSubagentMaxConcurrent()).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });

  it("returns default when subagents config is missing", () => {
    expect(resolveSubagentMaxConcurrent({} as OpenClawConfig)).toBe(
      DEFAULT_SUBAGENT_MAX_CONCURRENT,
    );
  });

  it("returns configured value", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxConcurrent: 16 } } },
    } as OpenClawConfig;
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(16);
  });

  it("floors fractional values", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxConcurrent: 5.7 } } },
    } as OpenClawConfig;
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(5);
  });

  it("clamps to minimum of 1", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxConcurrent: 0 } } },
    } as OpenClawConfig;
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
  });
});

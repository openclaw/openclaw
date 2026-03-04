import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
} from "./agent-limits.js";
import type { OpenClawConfig } from "./types.js";

describe("agent-limits", () => {
  describe("resolveAgentMaxConcurrent", () => {
    it("returns default when config is undefined", () => {
      expect(resolveAgentMaxConcurrent(undefined)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    });

    it("returns default when config has no agents", () => {
      const cfg: OpenClawConfig = {};
      expect(resolveAgentMaxConcurrent(cfg)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    });

    it("returns default when maxConcurrent is not set", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: {} },
      };
      expect(resolveAgentMaxConcurrent(cfg)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    });

    it("returns configured value when valid", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { maxConcurrent: 8 } },
      };
      expect(resolveAgentMaxConcurrent(cfg)).toBe(8);
    });

    it("floors decimal values", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { maxConcurrent: 5.7 } },
      };
      expect(resolveAgentMaxConcurrent(cfg)).toBe(5);
    });

    it("returns 1 for values less than 1", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { maxConcurrent: 0 } },
      };
      expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
    });

    it("returns 1 for negative values", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { maxConcurrent: -5 } },
      };
      expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
    });

    it("returns default for NaN", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { maxConcurrent: NaN } },
      };
      expect(resolveAgentMaxConcurrent(cfg)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    });

    it("returns default for Infinity", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { maxConcurrent: Infinity } },
      };
      expect(resolveAgentMaxConcurrent(cfg)).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    });
  });

  describe("resolveSubagentMaxConcurrent", () => {
    it("returns default when config is undefined", () => {
      expect(resolveSubagentMaxConcurrent(undefined)).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    });

    it("returns default when config has no subagents", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: {} },
      };
      expect(resolveSubagentMaxConcurrent(cfg)).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    });

    it("returns configured value when valid", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { subagents: { maxConcurrent: 12 } } },
      };
      expect(resolveSubagentMaxConcurrent(cfg)).toBe(12);
    });

    it("floors decimal values", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { subagents: { maxConcurrent: 10.9 } } },
      };
      expect(resolveSubagentMaxConcurrent(cfg)).toBe(10);
    });

    it("returns 1 for values less than 1", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { subagents: { maxConcurrent: 0 } } },
      };
      expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
    });

    it("returns default for NaN", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { subagents: { maxConcurrent: NaN } } },
      };
      expect(resolveSubagentMaxConcurrent(cfg)).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    });
  });

  describe("constants", () => {
    it("has expected default values", () => {
      expect(DEFAULT_AGENT_MAX_CONCURRENT).toBe(4);
      expect(DEFAULT_SUBAGENT_MAX_CONCURRENT).toBe(8);
      expect(DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH).toBe(1);
    });
  });
});

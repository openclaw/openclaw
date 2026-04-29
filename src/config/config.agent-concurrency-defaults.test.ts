import { describe, expect, it } from "vitest";
import {
  listConfiguredAgentCommandLaneConcurrencies,
  resolveAgentCommandLane,
  resolveAgentCommandLaneConfig,
} from "./agent-command-lanes.js";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
} from "./agent-limits.js";
import { applyAgentDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent concurrency defaults", () => {
  it("resolves defaults when unset", () => {
    expect(resolveAgentMaxConcurrent({})).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(resolveSubagentMaxConcurrent({})).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });

  it("clamps invalid values to at least 1", () => {
    const cfg = {
      agents: {
        defaults: {
          maxConcurrent: 0,
          subagents: { maxConcurrent: -3 },
        },
      },
    };
    expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
  });

  it("accepts subagent spawn depth and per-agent child limits", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 7,
          },
        },
      },
    });

    expect(parsed.agents?.defaults?.subagents?.maxSpawnDepth).toBe(2);
    expect(parsed.agents?.defaults?.subagents?.maxChildrenPerAgent).toBe(7);
  });

  it("accepts command lane defaults and per-agent overrides", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          commandLane: {
            id: "inbound",
            maxConcurrent: 3,
          },
        },
        list: [
          { id: "main" },
          {
            id: "heavy",
            commandLane: {
              id: "agent:heavy",
              maxConcurrent: 1,
            },
          },
        ],
      },
    }) as unknown as OpenClawConfig;

    expect(resolveAgentCommandLane(parsed, "main")).toBe("inbound");
    expect(resolveAgentCommandLaneConfig(parsed, "heavy")).toEqual({
      lane: "agent:heavy",
      maxConcurrent: 1,
    });
    expect(listConfiguredAgentCommandLaneConcurrencies(parsed)).toEqual([
      { lane: "inbound", maxConcurrent: 3 },
      { lane: "agent:heavy", maxConcurrent: 1 },
    ]);
  });

  it("rejects invalid command lane config", () => {
    expect(() =>
      OpenClawSchema.parse({
        agents: {
          defaults: {
            commandLane: {
              id: "   ",
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      OpenClawSchema.parse({
        agents: {
          list: [{ id: "heavy", commandLane: { id: "agent:heavy", maxConcurrent: 0 } }],
        },
      }),
    ).toThrow();
  });

  it("injects missing agent defaults", () => {
    const cfg = applyAgentDefaults({});

    expect(cfg.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(cfg.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });
});

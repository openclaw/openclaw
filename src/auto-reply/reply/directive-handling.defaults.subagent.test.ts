import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSubagentSessionDefaultModel } from "./directive-handling.defaults.js";

const baseCfg: OpenClawConfig = {
  agents: {
    defaults: {
      subagents: {
        model: { primary: "openai-codex/gpt-5.5" },
      },
    },
    list: {
      main: {
        model: { primary: "anthropic/claude-opus-4-7" },
        subagents: {
          model: { primary: "openai-codex/gpt-5.5" },
        },
      },
    },
  },
} as unknown as OpenClawConfig;

describe("resolveSubagentSessionDefaultModel", () => {
  it("returns the configured subagent default for a subagent session entry", () => {
    const ref = resolveSubagentSessionDefaultModel({
      cfg: baseCfg,
      agentId: "main",
      sessionEntry: { subagentRole: "orchestrator", spawnDepth: 1 },
      defaultProvider: "anthropic",
    });
    expect(ref).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  });

  it("returns the subagent default when only spawnDepth >= 1 is set", () => {
    const ref = resolveSubagentSessionDefaultModel({
      cfg: baseCfg,
      agentId: "main",
      sessionEntry: { spawnDepth: 1 },
      defaultProvider: "anthropic",
    });
    expect(ref?.model).toBe("gpt-5.5");
  });

  it("returns the subagent default when only subagentRole is set", () => {
    const ref = resolveSubagentSessionDefaultModel({
      cfg: baseCfg,
      agentId: "main",
      sessionEntry: { subagentRole: "leaf" },
      defaultProvider: "anthropic",
    });
    expect(ref?.model).toBe("gpt-5.5");
  });

  it("returns null for a non-subagent session entry so the parent primary is preserved", () => {
    const ref = resolveSubagentSessionDefaultModel({
      cfg: baseCfg,
      agentId: "main",
      sessionEntry: {},
      defaultProvider: "anthropic",
    });
    expect(ref).toBeNull();
  });

  it("returns null when spawnDepth is 0 (root session)", () => {
    const ref = resolveSubagentSessionDefaultModel({
      cfg: baseCfg,
      agentId: "main",
      sessionEntry: { spawnDepth: 0 },
      defaultProvider: "anthropic",
    });
    expect(ref).toBeNull();
  });

  it("returns null when no agentId is provided even for a subagent entry", () => {
    const ref = resolveSubagentSessionDefaultModel({
      cfg: baseCfg,
      sessionEntry: { subagentRole: "orchestrator", spawnDepth: 1 },
      defaultProvider: "anthropic",
    });
    expect(ref).toBeNull();
  });

  it("falls back to agents.defaults.subagents.model when the agent has no subagents.model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          subagents: {
            model: { primary: "openai-codex/gpt-5.5" },
          },
        },
        list: {
          other: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const ref = resolveSubagentSessionDefaultModel({
      cfg,
      agentId: "other",
      sessionEntry: { subagentRole: "orchestrator", spawnDepth: 1 },
      defaultProvider: "anthropic",
    });
    expect(ref).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  });
});

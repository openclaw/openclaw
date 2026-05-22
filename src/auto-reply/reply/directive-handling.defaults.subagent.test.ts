import { describe, expect, it } from "vitest";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
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

  it("resolves a configured subagent model alias through the alias index", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "openai/gpt-5.4": { alias: "gpt" },
          },
          subagents: { model: "gpt" },
        },
        list: {
          main: {
            model: { primary: "anthropic/claude-opus-4-7" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const ref = resolveSubagentSessionDefaultModel({
      cfg,
      agentId: "main",
      sessionEntry: { subagentRole: "orchestrator", spawnDepth: 1 },
      defaultProvider: "anthropic",
    });

    expect(ref).toEqual({ provider: "openai", model: "gpt-5.4" });
  });
});

describe("subagent default alias-index rebuild (get-reply integration)", () => {
  // Regression for ClawSweeper P2: after the reply runtime switches
  // defaultProvider to the subagent default, bare-model overrides without a
  // matching alias must resolve under the subagent provider — not the stale
  // parent provider that built the original alias index.
  it("rebuilt alias index resolves bare overrides under the subagent provider", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          subagents: {
            model: { primary: "openai/gpt-5.4" },
          },
        },
        list: {
          main: {
            model: { primary: "anthropic/claude-opus-4-7" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const parentProvider = "anthropic";
    const parentAliasIndex = buildModelAliasIndex({ cfg, defaultProvider: parentProvider });
    // Sanity: with the parent provider as default, a bare model id resolves
    // under the parent (the stale-aliasIndex path the bug exposed).
    const parentResolved = resolveModelRefFromString({
      cfg,
      raw: "gpt-5.4",
      defaultProvider: parentProvider,
      aliasIndex: parentAliasIndex,
    });
    expect(parentResolved?.ref.provider).toBe("anthropic");

    const subagentDefault = resolveSubagentSessionDefaultModel({
      cfg,
      agentId: "main",
      sessionEntry: { subagentRole: "orchestrator", spawnDepth: 1 },
      defaultProvider: parentProvider,
    });
    expect(subagentDefault).toEqual({ provider: "openai", model: "gpt-5.4" });

    // Mirror the get-reply rebuild: aliasIndex must be rebuilt with the
    // subagent provider as the new default. After the rebuild, the same bare
    // override now resolves under the subagent provider.
    const rebuiltAliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: subagentDefault!.provider,
    });
    const subagentResolved = resolveModelRefFromString({
      cfg,
      raw: "gpt-5.4",
      defaultProvider: subagentDefault!.provider,
      aliasIndex: rebuiltAliasIndex,
    });
    expect(subagentResolved?.ref).toEqual({ provider: "openai", model: "gpt-5.4" });
  });
});

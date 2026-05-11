import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveResetPreservedSelection } from "./reset-preserved-selection.js";

describe("resolveResetPreservedSelection", () => {
  it("preserves generic legacy user overrides without a source marker", () => {
    const preserved = resolveResetPreservedSelection({
      entry: {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-1",
      },
    });

    expect(preserved).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelOverrideSource: "user",
    });
  });

  it("drops stale legacy openai-codex overrides when the agent now uses native codex", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          agentRuntime: { id: "codex" },
          model: { primary: "openai/gpt-5.5" },
        },
      },
    };

    const preserved = resolveResetPreservedSelection({
      cfg,
      agentId: "main",
      entry: {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.5",
      },
    });

    expect(preserved.providerOverride).toBeUndefined();
    expect(preserved.modelOverride).toBeUndefined();
    expect(preserved.modelOverrideSource).toBeUndefined();
  });
});

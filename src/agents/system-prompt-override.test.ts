import { describe, expect, it } from "vitest";
import {
  combineSystemPromptOverrideWithExtra,
  resolveSystemPromptOverride,
} from "./system-prompt-override.js";

describe("resolveSystemPromptOverride", () => {
  it("uses defaults when no per-agent override exists", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "  default system  " },
            list: [{ id: "main" }],
          },
        },
        agentId: "main",
      }),
    ).toBe("default system");
  });

  it("prefers the per-agent override", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main", systemPromptOverride: "  agent system  " }],
          },
        },
        agentId: "main",
      }),
    ).toBe("agent system");
  });

  it("ignores blank override values", () => {
    expect(
      resolveSystemPromptOverride({
        config: {
          agents: {
            defaults: { systemPromptOverride: "default system" },
            list: [{ id: "main", systemPromptOverride: "   " }],
          },
        },
        agentId: "main",
      }),
    ).toBe("default system");
  });
});

describe("combineSystemPromptOverrideWithExtra (#73624)", () => {
  it("returns undefined when no override is present so callers fall back", () => {
    expect(
      combineSystemPromptOverrideWithExtra({
        override: undefined,
        extraSystemPrompt: "## Your Role\n- do the thing",
      }),
    ).toBeUndefined();
    expect(
      combineSystemPromptOverrideWithExtra({
        override: "   ",
        extraSystemPrompt: "## Your Role",
      }),
    ).toBeUndefined();
  });

  it("returns the override alone when extraSystemPrompt is missing or blank", () => {
    expect(
      combineSystemPromptOverrideWithExtra({
        override: "   you are a focused assistant   ",
        extraSystemPrompt: undefined,
      }),
    ).toBe("you are a focused assistant");
    expect(
      combineSystemPromptOverrideWithExtra({
        override: "you are a focused assistant",
        extraSystemPrompt: "   ",
      }),
    ).toBe("you are a focused assistant");
  });

  it("appends the trimmed extraSystemPrompt with a blank line separator", () => {
    // Regression for #73624: subagent spawns hand the `## Your Role` block
    // through `extraSystemPrompt`. Before this combination, an agent-level
    // `systemPromptOverride` would silently drop the role block, leaving
    // the spawned child to read only the bootstrap user message and
    // wander off into context/memory in confusion.
    const combined = combineSystemPromptOverrideWithExtra({
      override: "you are a focused assistant",
      extraSystemPrompt: "## Your Role\n- handle delegated task",
    });
    expect(combined).toBe("you are a focused assistant\n\n## Your Role\n- handle delegated task");
  });
});

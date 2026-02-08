import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("AgentDefaultsSchema subagents.allowAgents", () => {
  it("accepts allowAgents with wildcard", () => {
    const input = {
      subagents: {
        allowAgents: ["*"],
      },
    };
    const result = AgentDefaultsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts allowAgents with specific agent ids", () => {
    const input = {
      subagents: {
        allowAgents: ["research", "code-review"],
        maxConcurrent: 2,
      },
    };
    const result = AgentDefaultsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects non-string array in allowAgents", () => {
    const input = {
      subagents: {
        allowAgents: [123],
      },
    };
    const result = AgentDefaultsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

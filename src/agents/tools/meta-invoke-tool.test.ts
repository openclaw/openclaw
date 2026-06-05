import { describe, expect, it, vi } from "vitest";
import type { MetaSkillCatalog } from "../../skills/meta/catalog.js";
import type { MetaPlan } from "../../skills/meta/types.js";
import { createMetaInvokeTool } from "./meta-invoke-tool.js";

function readSchemaProperty(schema: unknown, key: string): Record<string, unknown> {
  const root = schema as { properties?: Record<string, unknown> };
  const property = root.properties?.[key];
  if (property === undefined) {
    throw new Error(`expected schema property ${key}`);
  }
  return property as Record<string, unknown>;
}

const testPlan = {
  name: "draft_reply",
  description: "Draft a concise reply",
  triggers: [{ pattern: "draft reply" }, { pattern: "respond briefly" }],
  steps: [
    {
      id: "draft",
      kind: "llm_chat",
      dependsOn: [],
      prompt: "Write the reply.",
      onFailure: { kind: "fail" },
    },
  ],
  finalTextMode: { kind: "auto" },
} satisfies MetaPlan;

function createCatalog(): MetaSkillCatalog {
  return {
    plans: [testPlan],
    diagnostics: [],
  };
}

describe("createMetaInvokeTool", () => {
  it("exposes the meta_invoke schema and runs the selected plan", async () => {
    const runPlan = vi.fn().mockResolvedValue({
      status: "succeeded",
      finalText: "Drafted reply.",
      outputs: {
        draft: {
          text: "Drafted reply.",
        },
      },
      steps: {
        draft: {
          status: "succeeded",
          output: {
            text: "Drafted reply.",
          },
        },
      },
    });
    const tool = createMetaInvokeTool({
      catalog: createCatalog(),
      runPlan,
    });

    const skillName = readSchemaProperty(tool.parameters, "skill_name");
    const input = readSchemaProperty(tool.parameters, "input");

    expect(tool.name).toBe("meta_invoke");
    expect(tool.description).toContain("draft_reply: Draft a concise reply");
    expect(tool.description).toContain("Triggers: draft reply, respond briefly.");
    expect(tool.description).toContain("paused for user_input");
    expect(skillName.type).toBe("string");
    expect(String(skillName.description)).toContain("Available meta skills:");
    expect(String(skillName.description)).toContain("draft_reply: Draft a concise reply");
    expect(String(input.description)).toContain("pending user_input pause");
    expect(input.type).toBe("object");

    const result = await tool.execute("call-1", {
      skill_name: "draft_reply",
      input: {
        tone: "brief",
      },
    });

    expect(runPlan).toHaveBeenCalledWith({
      plan: testPlan,
      input: {
        tone: "brief",
      },
      parentToolCallId: "call-1",
    });
    expect(result.content).toEqual([{ type: "text", text: "Drafted reply." }]);
    expect(result.details).toEqual({
      status: "succeeded",
      skillName: "draft_reply",
      steps: {
        draft: {
          status: "succeeded",
          output: {
            text: "Drafted reply.",
          },
        },
      },
      outputs: {
        draft: {
          text: "Drafted reply.",
        },
      },
    });
  });

  it("normalizes omitted input to an empty object", async () => {
    const runPlan = vi.fn().mockResolvedValue({
      status: "succeeded",
      finalText: "ok",
      outputs: {},
      steps: {},
    });
    const tool = createMetaInvokeTool({
      catalog: createCatalog(),
      runPlan,
    });

    await tool.execute("call-1", {
      skill_name: "draft_reply",
    });

    expect(runPlan).toHaveBeenCalledWith({
      plan: testPlan,
      input: {},
      parentToolCallId: "call-1",
    });
  });

  it("rejects invalid input payloads instead of dropping them", async () => {
    const runPlan = vi.fn();
    const tool = createMetaInvokeTool({
      catalog: createCatalog(),
      runPlan,
    });

    await expect(
      tool.execute("call-1", {
        skill_name: "draft_reply",
        input: ["not", "an", "object"],
      }),
    ).rejects.toThrow("input must be an object");
    expect(runPlan).not.toHaveBeenCalled();
  });

  it("throws a clear error for unknown meta skills", async () => {
    const runPlan = vi.fn();
    const tool = createMetaInvokeTool({
      catalog: createCatalog(),
      runPlan,
    });

    await expect(
      tool.execute("call-1", {
        skill_name: "missing_skill",
      }),
    ).rejects.toThrow("Unknown meta skill: missing_skill");
    expect(runPlan).not.toHaveBeenCalled();
  });
});

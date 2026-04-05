import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("agent defaults schema", () => {
  it("accepts subagent archiveAfterMinutes=0 to disable archiving", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          archiveAfterMinutes: 0,
        },
      }),
    ).not.toThrow();
  });

  it("accepts videoGenerationModel", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        videoGenerationModel: {
          primary: "qwen/wan2.6-t2v",
          fallbacks: ["minimax/video-01"],
        },
      }),
    ).not.toThrow();
  });

  it("accepts subagent taskRoutes", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          taskRoutes: [
            {
              whenTaskIncludes: ["review", "verify"],
              agentId: "reviewer",
              model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.4-mini"] },
              thinking: "medium",
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("accepts per-agent subagent taskRoutes", () => {
    expect(() =>
      AgentEntrySchema.parse({
        id: "reviewer",
        subagents: {
          taskRoutes: [
            {
              whenTaskIncludes: ["review"],
              model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.4-mini"] },
              thinking: "medium",
            },
          ],
        },
      }),
    ).not.toThrow();
  });
});

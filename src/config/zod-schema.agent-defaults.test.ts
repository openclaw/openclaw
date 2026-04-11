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

  it("accepts mediaGenerationAutoProviderFallback", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        mediaGenerationAutoProviderFallback: false,
      }),
    ).not.toThrow();
  });

  it("accepts contextInjection: always", () => {
    const result = AgentDefaultsSchema.parse({ contextInjection: "always" })!;
    expect(result.contextInjection).toBe("always");
  });

  it("accepts contextInjection: continuation-skip", () => {
    const result = AgentDefaultsSchema.parse({ contextInjection: "continuation-skip" })!;
    expect(result.contextInjection).toBe("continuation-skip");
  });

  it("rejects invalid contextInjection values", () => {
    expect(() => AgentDefaultsSchema.parse({ contextInjection: "never" })).toThrow();
  });

  it("accepts bootstrapSignatureMode: lenient", () => {
    const result = AgentDefaultsSchema.parse({ bootstrapSignatureMode: "lenient" })!;
    expect(result.bootstrapSignatureMode).toBe("lenient");
  });

  it("accepts bootstrapSignatureMode: strict", () => {
    const result = AgentDefaultsSchema.parse({ bootstrapSignatureMode: "strict" })!;
    expect(result.bootstrapSignatureMode).toBe("strict");
  });

  it("accepts bootstrapSignatureMode: auto", () => {
    const result = AgentDefaultsSchema.parse({ bootstrapSignatureMode: "auto" })!;
    expect(result.bootstrapSignatureMode).toBe("auto");
  });

  it("rejects invalid bootstrapSignatureMode values", () => {
    expect(() => AgentDefaultsSchema.parse({ bootstrapSignatureMode: "off" })).toThrow();
  });

  it("accepts embeddedPi.executionContract", () => {
    const result = AgentDefaultsSchema.parse({
      embeddedPi: {
        executionContract: "strict-agentic",
      },
    })!;
    expect(result.embeddedPi?.executionContract).toBe("strict-agentic");
  });

  it("accepts positive heartbeat timeoutSeconds on defaults and agent entries", () => {
    const defaults = AgentDefaultsSchema.parse({
      heartbeat: { timeoutSeconds: 45 },
    })!;
    const agent = AgentEntrySchema.parse({
      id: "ops",
      heartbeat: { timeoutSeconds: 45 },
    });

    expect(defaults.heartbeat?.timeoutSeconds).toBe(45);
    expect(agent.heartbeat?.timeoutSeconds).toBe(45);
  });

  it("rejects zero heartbeat timeoutSeconds", () => {
    expect(() => AgentDefaultsSchema.parse({ heartbeat: { timeoutSeconds: 0 } })).toThrow();
    expect(() => AgentEntrySchema.parse({ id: "ops", heartbeat: { timeoutSeconds: 0 } })).toThrow();
  });

  it("accepts model-aware AGENTS file overrides", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        agentsFile: "AGENTS.gpt.md",
        agentsFilesByModel: {
          "openai/gpt-5.4": "AGENTS.gpt-5.4.md",
        },
        subagents: {
          agentsFile: "SUBAGENTS.md",
          agentsFilesByModel: {
            "openai/gpt-5.4": "SUBAGENTS.gpt-5.4.md",
          },
        },
      }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

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

  it("accepts fallbacksFromModels on agents.defaults.model", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        model: {
          primary: "openai/gpt-5.4",
          fallbacksFromModels: true,
        },
      }),
    ).not.toThrow();
  });

  it("rejects fallbacksFromModels on imageModel", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        imageModel: {
          primary: "openai/gpt-4.1-mini",
          fallbacksFromModels: true,
        } as never,
      }),
    ).toThrow();
  });
});

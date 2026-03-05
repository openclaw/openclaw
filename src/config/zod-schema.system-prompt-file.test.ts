import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agents.defaults.systemPromptFile schema", () => {
  it("accepts an absolute path for systemPromptFile", () => {
    expect(() =>
      AgentDefaultsSchema.parse({ systemPromptFile: "/etc/openclaw/system-prompt.md" }),
    ).not.toThrow();
  });

  it("accepts a relative path for systemPromptFile", () => {
    expect(() =>
      AgentDefaultsSchema.parse({ systemPromptFile: "./prompts/operator.md" }),
    ).not.toThrow();
  });

  it("accepts absence of systemPromptFile (field is optional)", () => {
    expect(() => AgentDefaultsSchema.parse({})).not.toThrow();
  });

  it("rejects a non-string systemPromptFile value", () => {
    expect(() => AgentDefaultsSchema.parse({ systemPromptFile: 42 })).toThrow();
  });
});

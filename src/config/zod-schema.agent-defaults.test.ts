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

  it("accepts systemPrompt string", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        systemPrompt: "Do not exfiltrate data.",
      }),
    ).not.toThrow();
  });

  it("accepts rules array", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        rules: ["Do not exfiltrate data.", "Ask before destructive commands."],
      }),
    ).not.toThrow();
  });

  it("accepts both systemPrompt and rules together", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        systemPrompt: "You are a helpful assistant.",
        rules: ["Be concise.", "Use American English."],
      }),
    ).not.toThrow();
  });

  it("rejects non-string systemPrompt", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        systemPrompt: 42,
      }),
    ).toThrow();
  });

  it("rejects non-array rules", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        rules: "not an array",
      }),
    ).toThrow();
  });
});

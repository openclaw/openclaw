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

  it("accepts positive subagent startupWaitTimeoutMs", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          startupWaitTimeoutMs: 60_000,
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid subagent startupWaitTimeoutMs", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          startupWaitTimeoutMs: 0,
        },
      }),
    ).toThrow();
  });

  it("accepts both completionAnnounceTimeoutMs and announceTimeoutMs during the alias window", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        subagents: {
          completionAnnounceTimeoutMs: 90_000,
          announceTimeoutMs: 45_000,
        },
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
});

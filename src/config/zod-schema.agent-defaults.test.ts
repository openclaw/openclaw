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

  it("accepts embeddedPi overloadBackoffMaxMs as a non-negative integer", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        embeddedPi: {
          overloadBackoffMaxMs: 500,
        },
      }),
    ).not.toThrow();
  });
});

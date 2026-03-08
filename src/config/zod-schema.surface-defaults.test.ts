import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("AgentDefaultsSchema surfaceDefaults", () => {
  it("accepts per-surface verbose/reasoning defaults", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        surfaceDefaults: {
          tui: { verboseDefault: "full", reasoningDefault: "on" },
          discord: { verboseDefault: "off", reasoningDefault: "off" },
          telegram: { reasoningDefault: "stream" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects unsupported keys in surface defaults", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        surfaceDefaults: {
          tui: { thinkingDefault: "high" },
        },
      }),
    ).toThrow();
  });

  it("rejects invalid enum values", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        surfaceDefaults: {
          discord: { verboseDefault: "loud", reasoningDefault: "visible" },
        },
      }),
    ).toThrow();
  });
});

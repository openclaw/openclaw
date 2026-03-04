import { describe, expect, it } from "vitest";
import { ClaudeSdkConfigSchema } from "./zod-schema.agent-runtime.js";

describe("ClaudeSdkConfigSchema", () => {
  it("accepts empty claudeSdk config", () => {
    const parsed = ClaudeSdkConfigSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("accepts optional configDir", () => {
    const parsed = ClaudeSdkConfigSchema.parse({
      configDir: "/tmp/claude-config",
    });
    expect(parsed?.configDir).toBe("/tmp/claude-config");
  });

  it("rejects blank configDir after trimming", () => {
    expect(() => ClaudeSdkConfigSchema.parse({ configDir: "   " })).toThrow();
  });

  it("rejects thinkingDefault (moved to agents.defaults/agents.list)", () => {
    expect(() => ClaudeSdkConfigSchema.parse({ thinkingDefault: "low" })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => ClaudeSdkConfigSchema.parse({ provider: "claude-sdk" })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

function validateMapping(mapping: Record<string, unknown>, hooks: Record<string, unknown> = {}) {
  return validateConfigObjectWithPlugins({
    hooks: {
      ...hooks,
      mappings: [{ action: "agent", messageTemplate: "card update", ...mapping }],
    },
  });
}

describe("config hook session mode", () => {
  it.each(["isolated", "persistent"] as const)("accepts %s hook mappings", (sessionMode) => {
    const result = validateMapping({
      sessionMode,
      ...(sessionMode === "persistent" ? { sessionKey: "hook:card-update" } : {}),
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a persistent mapping with a transform-provided session key", () => {
    const result = validateMapping({
      sessionMode: "persistent",
      transform: { module: "card-update.ts" },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a persistent mapping with a default session key", () => {
    const result = validateMapping(
      { sessionMode: "persistent" },
      { defaultSessionKey: "hook:card-update" },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects persistent mappings without a stable session key source", () => {
    const result = validateMapping({ sessionMode: "persistent" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain("hooks.mappings.0.sessionKey");
    }
  });

  it("rejects unknown hook mapping session modes", () => {
    const result = validateMapping({ sessionMode: "shared" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain("hooks.mappings.0.sessionMode");
    }
  });
});

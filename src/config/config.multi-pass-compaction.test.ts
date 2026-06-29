import { describe, expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

// Extract the compaction sub-schema from AgentDefaultsSchema.
// AgentDefaultsSchema is ZodOptional<ZodObject> -- unwrap the optional first,
// then access the compaction shape and unwrap its optional wrapper.
const compactionSchema = AgentDefaultsSchema.unwrap().shape.compaction.unwrap();

// Helper to test full config materialization:
function materializeCompactionConfig(input: Record<string, unknown>) {
  const cfg = applyCompactionDefaults({
    agents: { defaults: { compaction: input } },
  } as unknown as OpenClawConfig);
  return (cfg.agents?.defaults as Record<string, unknown>)?.compaction as Record<string, unknown>;
}

// -- Suite G: Configuration Schema Extension --

describe("compaction configuration defaults", () => {
  it("applies default mode='safeguard' when not specified", () => {
    const result = materializeCompactionConfig({});
    expect(result.mode).toBe("safeguard");
  });

  it("preserves user-specified mode", () => {
    const result = materializeCompactionConfig({ mode: "safeguard" });
    expect(result.mode).toBe("safeguard");
  });

  it("preserves existing compaction settings", () => {
    const result = materializeCompactionConfig({
      mode: "safeguard",
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      recentTurnsPreserve: 3,
    });
    expect(result.mode).toBe("safeguard");
    expect(result.reserveTokens).toBe(16384);
    expect(result.keepRecentTokens).toBe(20000);
    expect(result.recentTurnsPreserve).toBe(3);
  });

  it("handles undefined compaction block gracefully", () => {
    const cfg = applyCompactionDefaults({} as OpenClawConfig);
    expect(cfg).toBeDefined();
  });
});

describe("compaction Zod schema validation", () => {
  it("accepts valid compaction config", () => {
    const result = compactionSchema.safeParse({
      mode: "safeguard",
    });
    expect(result.success).toBe(true);
  });

  it("backwards-compatible with standard configs", () => {
    const result = compactionSchema.safeParse({
      mode: "safeguard",
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys in compaction config (strict mode)", () => {
    const result = compactionSchema.safeParse({
      unknownField: "surprise",
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxPasses since it is an internal-only setting", () => {
    // maxPasses is intentionally not in the user-facing config schema;
    // it is an internal constant (MAX_COMPACTION_PASSES = 3) that will
    // be wired when multi-pass integration is complete.
    const result = compactionSchema.safeParse({
      mode: "safeguard",
      maxPasses: 3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects progressThreshold since it is an internal-only setting", () => {
    // progressThreshold is intentionally not in the user-facing config
    // schema; it is an internal constant (PROGRESS_THRESHOLD = 0.05).
    const result = compactionSchema.safeParse({
      mode: "safeguard",
      progressThreshold: 0.05,
    });
    expect(result.success).toBe(false);
  });
});

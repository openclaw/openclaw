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

describe("multi-pass compaction configuration defaults", () => {
  it("applies default maxPasses=3 when not specified", () => {
    const result = materializeCompactionConfig({});
    expect(result.maxPasses).toBe(3);
  });

  it("applies default progressThreshold=0.05 when not specified", () => {
    const result = materializeCompactionConfig({});
    expect(result.progressThreshold).toBe(0.05);
  });

  it("preserves user-specified maxPasses", () => {
    const result = materializeCompactionConfig({ maxPasses: 5 });
    expect(result.maxPasses).toBe(5);
  });

  it("preserves user-specified progressThreshold", () => {
    const result = materializeCompactionConfig({ progressThreshold: 0.1 });
    expect(result.progressThreshold).toBe(0.1);
  });

  it("applies new field defaults even when mode is already set", () => {
    const result = materializeCompactionConfig({ mode: "safeguard" });
    expect(result.mode).toBe("safeguard");
    expect(result.maxPasses).toBe(3);
    expect(result.progressThreshold).toBe(0.05);
  });

  it("preserves existing compaction settings alongside new fields", () => {
    const result = materializeCompactionConfig({
      mode: "safeguard",
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      maxPasses: 2,
      recentTurnsPreserve: 3,
    });
    expect(result.mode).toBe("safeguard");
    expect(result.reserveTokens).toBe(16384);
    expect(result.keepRecentTokens).toBe(20000);
    expect(result.maxPasses).toBe(2);
    expect(result.recentTurnsPreserve).toBe(3);
  });

  it("handles undefined compaction block gracefully", () => {
    const cfg = applyCompactionDefaults({} as OpenClawConfig);
    expect(cfg).toBeDefined();
  });
});

describe("multi-pass compaction Zod schema validation", () => {
  it("accepts valid multi-pass config fields", () => {
    const result = compactionSchema.safeParse({
      mode: "safeguard",
      maxPasses: 3,
      progressThreshold: 0.05,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type for maxPasses", () => {
    const result = compactionSchema.safeParse({ maxPasses: "three" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid type for progressThreshold", () => {
    const result = compactionSchema.safeParse({ progressThreshold: "five percent" });
    expect(result.success).toBe(false);
  });

  it("rejects maxPasses below minimum via Zod schema", () => {
    const result = compactionSchema.safeParse({ maxPasses: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects maxPasses above maximum via Zod schema", () => {
    const result = compactionSchema.safeParse({ maxPasses: 100 });
    expect(result.success).toBe(false);
  });

  it("rejects progressThreshold at zero via Zod schema", () => {
    const result = compactionSchema.safeParse({ progressThreshold: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects progressThreshold at 1.0 via Zod schema", () => {
    const result = compactionSchema.safeParse({ progressThreshold: 1 });
    expect(result.success).toBe(false);
  });

  it("backwards-compatible with pre-multi-pass configs", () => {
    const result = compactionSchema.safeParse({
      mode: "safeguard",
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys in compaction config (strict mode)", () => {
    const result = compactionSchema.safeParse({
      maxPasses: 3,
      unknownField: "surprise",
    });
    expect(result.success).toBe(false);
  });
});

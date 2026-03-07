import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

/**
 * Continuation config Zod schema boundary tests.
 *
 * Validates that invalid config values are rejected at parse time,
 * not silently swallowed or reset to defaults. Convention: fail loudly.
 */

function parseContinuation(continuation: unknown) {
  return AgentDefaultsSchema.safeParse({ continuation });
}

describe("continuation config schema validation", () => {
  /* ---------------------------------------------------------------- */
  /*  contextPressureThreshold: z.number().gt(0).max(1).optional()    */
  /* ---------------------------------------------------------------- */

  it("accepts contextPressureThreshold = 0.8", () => {
    const result = parseContinuation({ contextPressureThreshold: 0.8 });
    expect(result.success).toBe(true);
  });

  it("rejects contextPressureThreshold = 0", () => {
    const result = parseContinuation({ contextPressureThreshold: 0 });
    expect(result.success).toBe(false);
  });

  it("accepts contextPressureThreshold = 1.0 (upper bound)", () => {
    const result = parseContinuation({ contextPressureThreshold: 1.0 });
    expect(result.success).toBe(true);
  });

  it("rejects contextPressureThreshold = -1 (below min)", () => {
    const result = parseContinuation({ contextPressureThreshold: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects contextPressureThreshold = 2.0 (above max)", () => {
    const result = parseContinuation({ contextPressureThreshold: 2.0 });
    expect(result.success).toBe(false);
  });

  it("rejects contextPressureThreshold = 'bc annoying' (string)", () => {
    const result = parseContinuation({ contextPressureThreshold: "bc annoying" });
    expect(result.success).toBe(false);
  });

  it("accepts contextPressureThreshold = undefined (optional)", () => {
    const result = parseContinuation({});
    expect(result.success).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /*  maxDelegatesPerTurn: z.number().int().positive().optional()      */
  /* ---------------------------------------------------------------- */

  it("accepts maxDelegatesPerTurn = 5", () => {
    const result = parseContinuation({ maxDelegatesPerTurn: 5 });
    expect(result.success).toBe(true);
  });

  it("rejects maxDelegatesPerTurn = 0 (not positive)", () => {
    const result = parseContinuation({ maxDelegatesPerTurn: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects maxDelegatesPerTurn = -1 (negative)", () => {
    const result = parseContinuation({ maxDelegatesPerTurn: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects maxDelegatesPerTurn = 3.5 (not integer)", () => {
    const result = parseContinuation({ maxDelegatesPerTurn: 3.5 });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  costCapTokens: z.number().int().nonnegative().optional()         */
  /* ---------------------------------------------------------------- */

  it("accepts costCapTokens = 0 (nonnegative includes zero)", () => {
    const result = parseContinuation({ costCapTokens: 0 });
    expect(result.success).toBe(true);
  });

  it("accepts costCapTokens = 500000", () => {
    const result = parseContinuation({ costCapTokens: 500000 });
    expect(result.success).toBe(true);
  });

  it("rejects costCapTokens = -1 (negative)", () => {
    const result = parseContinuation({ costCapTokens: -1 });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  defaultDelayMs / minDelayMs / maxDelayMs / maxChainLength       */
  /* ---------------------------------------------------------------- */

  it("rejects defaultDelayMs = 0 (not positive)", () => {
    const result = parseContinuation({ defaultDelayMs: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects minDelayMs = -100 (negative)", () => {
    const result = parseContinuation({ minDelayMs: -100 });
    expect(result.success).toBe(false);
  });

  it("rejects maxChainLength = 0 (not positive)", () => {
    const result = parseContinuation({ maxChainLength: 0 });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  enabled: z.boolean().optional()                                  */
  /* ---------------------------------------------------------------- */

  it("accepts enabled = true", () => {
    const result = parseContinuation({ enabled: true });
    expect(result.success).toBe(true);
  });

  it("rejects enabled = 'yes' (string, not boolean)", () => {
    const result = parseContinuation({ enabled: "yes" });
    expect(result.success).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /*  strict mode: unknown keys rejected                               */
  /* ---------------------------------------------------------------- */

  it("rejects unknown continuation keys (strict)", () => {
    const result = parseContinuation({ unknownKey: 42 });
    expect(result.success).toBe(false);
  });
});

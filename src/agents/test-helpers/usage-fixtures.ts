/**
 * Shared usage fixtures for agent tests.
 *
 * Message builders call the factory so transcript ownership cannot freeze usage
 * belonging to another message. The shared constant remains for explicit,
 * read-only alias fixtures.
 */
import type { Usage } from "openclaw/plugin-sdk/llm";

export function createZeroUsageFixture(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

/** Complete zero-cost usage with explicit token counts; totals are never inferred. */
export function createUsageFixture(input: number, output: number, totalTokens: number): Usage {
  return { ...createZeroUsageFixture(), input, output, totalTokens };
}

/** Shared read-only zero usage for tests that deliberately alias one fixture. */
export const ZERO_USAGE_FIXTURE: Usage = createZeroUsageFixture();

export function createRuntimeLlmUsageFixture() {
  return { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, total: 25, cost: { total: 0.0042 } };
}

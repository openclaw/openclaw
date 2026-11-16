/** Assertions for update outcomes and persisted source metadata. */
import { expect } from "vitest";

export function expectUpdateFields(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual?.[key]).toEqual(value);
  }
}

export function expectOutcome(result: { outcomes: unknown[] }, expected: Record<string, unknown>) {
  expect(result.outcomes).toEqual([expected]);
}

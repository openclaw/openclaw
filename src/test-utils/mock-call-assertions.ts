// Assertion helpers for inspecting Vitest mock call payloads.
import { expect } from "vitest";
import { createRequireRecord } from "../../test/helpers/record.js";

const requireRecord = createRequireRecord("record", "message");

/** Returns a mock call with a useful failure when the call is missing. */
export function mockCall(mock: unknown, index = 0): Array<unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(index);
  if (!call) {
    throw new Error(`Expected mock call ${index + 1}`);
  }
  return call;
}

export function mockFirstObjectArg(mock: unknown): Record<string, unknown> {
  const [arg] = mockCall(mock);
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first mock argument object");
  }
  return arg as Record<string, unknown>;
}

/** Returns the first argument as a non-array record, preserving labeled failures. */
export function mockFirstRecordArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
  invalidArgumentMessage = `expected ${label} input to be an object`,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return requireRecord(call[0], invalidArgumentMessage);
}

export function expectObjectFields(
  value: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("expected object fields");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
  return record;
}

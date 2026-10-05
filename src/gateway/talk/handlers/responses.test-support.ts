import { expect, vi } from "vitest";

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call.at(argIndex);
}

export function expectRespondOk(
  mock: ReturnType<typeof vi.fn>,
  expected?: Record<string, unknown>,
) {
  expect(mockCallArg(mock)).toBe(true);
  const result = mockCallArg(mock, 0, 1);
  if (expected) {
    expectRecordFields(result, expected);
  }
  expect(mockCallArg(mock, 0, 2)).toBeUndefined();
  return result;
}

export function expectRespondError(
  mock: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(mockCallArg(mock)).toBe(false);
  expect(mockCallArg(mock, 0, 1)).toBeUndefined();
  return expectRecordFields(mockCallArg(mock, 0, 2), expected);
}

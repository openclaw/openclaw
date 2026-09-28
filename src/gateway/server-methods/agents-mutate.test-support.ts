import { expect, type vi } from "vitest";

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
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

export function expectRespondOk(
  respond: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(mockCallArg(respond)).toBe(true);
  const payload = expectRecordFields(mockCallArg(respond, 0, 1), expected);
  expect(mockCallArg(respond, 0, 2)).toBeUndefined();
  return payload;
}

export function expectRespondErrorContaining(respond: ReturnType<typeof vi.fn>, text: string) {
  expect(mockCallArg(respond)).toBe(false);
  expect(mockCallArg(respond, 0, 1)).toBeUndefined();
  const error = expectRecordFields(mockCallArg(respond, 0, 2), {});
  expectStringContaining(error.message, text);
  return error;
}

export function firstRespondResult(respond: ReturnType<typeof vi.fn>): unknown {
  return mockCallArg(respond, 0, 1);
}

export function expectStringContaining(value: unknown, text: string) {
  expect(typeof value).toBe("string");
  expect(value as string).toContain(text);
}

export function expectStringNotContaining(value: unknown, text: string) {
  expect(typeof value).toBe("string");
  expect(value as string).not.toContain(text);
}

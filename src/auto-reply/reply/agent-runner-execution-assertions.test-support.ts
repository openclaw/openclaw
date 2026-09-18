// Generic record and mock-call assertion helpers for agent-runner execution tests.
import { expect } from "vitest";

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

export function expectMockCallArgFields(
  mock: unknown,
  index: number,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireRecord(requireMockCall(mock, index, label)[0], label), fields);
}

export function expectNoMockCallWithFields(mock: unknown, fields: Record<string, unknown>) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  const hasMatchingCall = calls.some((call) => {
    const value = call[0];
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return Object.entries(fields).every(([key, expected]) => record[key] === expected);
  });
  expect(hasMatchingCall).toBe(false);
}

export function requireMockCallArgWithFields(
  mock: unknown,
  fields: Record<string, unknown>,
  label: string,
) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  const found = calls
    .map((call) => call[0])
    .find((value) => {
      if (typeof value !== "object" || value === null) {
        return false;
      }
      const record = value as Record<string, unknown>;
      return Object.entries(fields).every(([key, expected]) => record[key] === expected);
    });
  if (!found) {
    throw new Error(`missing ${label}`);
  }
  return requireRecord(found, label);
}

export function expectBlockReplyCall(
  onBlockReply: unknown,
  index: number,
  fields: Record<string, unknown>,
) {
  expectMockCallArgFields(onBlockReply, index, "block reply payload", fields);
}

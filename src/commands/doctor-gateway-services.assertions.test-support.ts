import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";

export const requireRecord = createRequireRecord("object", "expected-label");

export function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  index: number,
  label: string,
) {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  return call[0];
}

export function expectCallField(
  mock: { mock: { calls: Array<Array<unknown>> } },
  field: string,
  expected: unknown,
) {
  const options = requireRecord(callArg(mock, 0, `first ${field} call`), field);
  expect(options[field]).toEqual(expected);
  return options;
}

export function expectGatewayAuthToken(value: unknown, expected: string) {
  const root = requireRecord(value, "config root");
  const gateway = requireRecord(root.gateway, "config.gateway");
  const auth = requireRecord(gateway.auth, "config.gateway.auth");
  expect(auth.token).toBe(expected);
}

function readGatewayAuthToken(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const root = value as Record<string, unknown>;
  const gateway = root.gateway;
  if (!gateway || typeof gateway !== "object") {
    return undefined;
  }
  const auth = (gateway as Record<string, unknown>).auth;
  if (!auth || typeof auth !== "object") {
    return undefined;
  }
  return (auth as Record<string, unknown>).token;
}

export function expectCallConfigGatewayAuthToken(
  mock: { mock: { calls: Array<Array<unknown>> } },
  expected: string,
) {
  const matchingCalls = mock.mock.calls.filter(([value]) => {
    const options = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return readGatewayAuthToken(options.config) === expected;
  });
  expect(matchingCalls).not.toEqual([]);
}

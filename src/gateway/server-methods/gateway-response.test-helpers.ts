/**
 * Assertion helpers for gateway method response envelopes.
 */
import { expect, type Mock } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";

type MockCallSource = {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
};

export function observeGatewayResponse(respond: Mock): Promise<void> {
  const firstResponse = createDeferredCore();
  respond.mockImplementationOnce(() => firstResponse.resolve());
  return firstResponse.promise;
}

/** Verifies that a mocked respond callback emitted the expected gateway error. */
export function expectGatewayErrorResponse(
  respond: MockCallSource,
  expected: { code: string; message: string },
) {
  const call = respond.mock.calls.at(0) as
    | [boolean, unknown, { code?: string; message?: string }]
    | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  expect(call?.[2]?.code).toBe(expected.code);
  expect(call?.[2]?.message).toBe(expected.message);
}

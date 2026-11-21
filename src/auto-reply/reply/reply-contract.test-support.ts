import { expect, type MockInstance } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";

export function beforeSettlement<T>(
  gate: PromiseLike<T>,
  work: PromiseLike<unknown>,
  signal: AbortSignal,
  message: string,
) {
  return withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
}

export function expectCallCounts(count: number, ...mocks: MockInstance[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

export function expectCalls(...checks: [MockInstance, unknown[][]][]) {
  for (const [mock, calls] of checks) {
    expect(mock.mock.calls).toEqual(calls);
  }
}

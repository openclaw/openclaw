import { expect } from "vitest";

export function expectCallCount(
  count: number,
  ...mocks: { mock: { calls: readonly unknown[] } }[]
) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

/** Always join fixture cleanup, preserving both failures when assertions and cleanup reject. */
export async function withRunLoopCleanup(
  assertion: () => Promise<void>,
  cleanup: () => Promise<void>,
  message: string,
) {
  const failures: unknown[] = [];
  for (const operation of [assertion, cleanup]) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message, { cause: failures[0] });
  }
  if (failures.length === 1) {
    throw failures[0];
  }
}

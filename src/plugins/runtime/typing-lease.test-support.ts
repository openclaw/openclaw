import { expect, vi } from "vitest";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";

export function expectTypingPulseCount(pulse: { mock: { calls: unknown[] } }, expected: number) {
  expect(pulse.mock.calls).toHaveLength(expected);
}

export function createPulseWithBackgroundFailure<
  TPulse extends (...args: never[]) => Promise<unknown>,
>() {
  let callCount = 0;
  const pulse: MockFn<TPulse> = vi.fn(async () => {
    callCount += 1;
    if (callCount === 2) {
      throw new Error("boom");
    }
    return undefined;
  }) as MockFn<TPulse>;
  return pulse;
}

export async function expectIndependentTypingLeases<
  TParams extends { intervalMs?: number; pulse: (...args: never[]) => Promise<unknown> },
  TLease extends { refresh: () => Promise<void>; stop: () => void },
>(params: {
  createLease: (params: TParams) => Promise<TLease>;
  buildParams: (pulse: TParams["pulse"]) => TParams;
}) {
  vi.useFakeTimers();
  const pulse: MockFn<TParams["pulse"]> = vi.fn(async () => undefined) as MockFn<TParams["pulse"]>;

  const leaseA = await params.createLease(params.buildParams(pulse));
  const leaseB = await params.createLease(params.buildParams(pulse));

  expectTypingPulseCount(pulse as unknown as { mock: { calls: unknown[] } }, 2);

  await vi.advanceTimersByTimeAsync(2_000);
  expectTypingPulseCount(pulse as unknown as { mock: { calls: unknown[] } }, 4);

  leaseA.stop();
  await vi.advanceTimersByTimeAsync(2_000);
  expectTypingPulseCount(pulse as unknown as { mock: { calls: unknown[] } }, 5);

  await leaseB.refresh();
  expectTypingPulseCount(pulse as unknown as { mock: { calls: unknown[] } }, 6);

  leaseB.stop();
}

export async function expectBackgroundTypingPulseFailuresAreSwallowed<
  TParams extends { intervalMs?: number; pulse: (...args: never[]) => Promise<unknown> },
  TLease extends { stop: () => void },
>(params: {
  createLease: (params: TParams) => Promise<TLease>;
  buildParams: (pulse: TParams["pulse"]) => TParams;
  pulse: TParams["pulse"];
}) {
  vi.useFakeTimers();

  const lease = await params.createLease(params.buildParams(params.pulse));

  await expect(vi.advanceTimersByTimeAsync(2_000)).resolves.toBe(vi);
  expectTypingPulseCount(params.pulse as unknown as { mock: { calls: unknown[] } }, 2);

  lease.stop();
}

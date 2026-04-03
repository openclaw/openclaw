import { expect, it, vi } from "vitest";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";

type MockedPulse = { mock: { calls: unknown[] } };

function asMockedPulse(pulse: unknown): MockedPulse {
  return pulse as MockedPulse;
}

export function expectTypingPulseCount(pulse: MockedPulse, expected: number) {
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
  const mockedPulse = asMockedPulse(pulse);

  const leaseA = await params.createLease(params.buildParams(pulse));
  const leaseB = await params.createLease(params.buildParams(pulse));

  expectTypingPulseCount(mockedPulse, 2);

  await vi.advanceTimersByTimeAsync(2_000);
  expectTypingPulseCount(mockedPulse, 4);

  leaseA.stop();
  await vi.advanceTimersByTimeAsync(2_000);
  expectTypingPulseCount(mockedPulse, 5);

  await leaseB.refresh();
  expectTypingPulseCount(mockedPulse, 6);

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
  const mockedPulse = asMockedPulse(params.pulse);

  const lease = await params.createLease(params.buildParams(params.pulse));

  await expect(vi.advanceTimersByTimeAsync(2_000)).resolves.toBe(vi);
  expectTypingPulseCount(mockedPulse, 2);

  lease.stop();
}

export function registerSharedTypingLeaseTests<
  TParams extends { intervalMs?: number; pulse: (...args: never[]) => Promise<unknown> },
  TLease extends { refresh: () => Promise<void>; stop: () => void },
>(params: {
  createLease: (params: TParams) => Promise<TLease>;
  buildParams: (pulse: TParams["pulse"]) => TParams;
}) {
  it("pulses immediately and keeps leases independent", async () => {
    await expectIndependentTypingLeases(params);
  });

  it("swallows background pulse failures", async () => {
    const pulse = createPulseWithBackgroundFailure<TParams["pulse"]>();

    await expectBackgroundTypingPulseFailuresAreSwallowed({
      createLease: params.createLease,
      pulse,
      buildParams: params.buildParams,
    });
  });
}

export async function expectDefaultTypingLeaseInterval<
  TParams extends { intervalMs?: number; pulse: (...args: never[]) => Promise<unknown> },
  TLease extends { stop: () => void },
>(params: {
  createLease: (params: TParams) => Promise<TLease>;
  buildParams: (pulse: TParams["pulse"]) => TParams;
  defaultIntervalMs: number;
}) {
  vi.useFakeTimers();
  const pulse = vi.fn(async () => undefined);

  const lease = await params.createLease({
    ...params.buildParams(pulse as TParams["pulse"]),
    intervalMs: Number.NaN,
  });

  expectTypingPulseCount(asMockedPulse(pulse), 1);
  await vi.advanceTimersByTimeAsync(params.defaultIntervalMs - 1);
  expectTypingPulseCount(asMockedPulse(pulse), 1);
  await vi.advanceTimersByTimeAsync(1);
  expectTypingPulseCount(asMockedPulse(pulse), 2);

  lease.stop();
}

import { expect, vi } from "vitest";

function expectPulseCount(pulse: { mock: { calls: unknown[] } }, expected: number) {
  expect(pulse.mock.calls).toHaveLength(expected);
}

export async function expectIndependentTypingLeases<
  TParams extends { intervalMs?: number; pulse: (...args: never[]) => Promise<unknown> },
  TLease extends { refresh: () => Promise<void>; stop: () => void },
>(params: {
  createLease: (params: TParams) => Promise<TLease>;
  buildParams: (pulse: TParams["pulse"]) => TParams;
}) {
  vi.useFakeTimers();
  const pulse = vi.fn(async () => undefined) as TParams["pulse"];

  const leaseA = await params.createLease(params.buildParams(pulse));
  const leaseB = await params.createLease(params.buildParams(pulse));

  expectPulseCount(pulse as unknown as { mock: { calls: unknown[] } }, 2);

  await vi.advanceTimersByTimeAsync(2_000);
  expectPulseCount(pulse as unknown as { mock: { calls: unknown[] } }, 4);

  leaseA.stop();
  await vi.advanceTimersByTimeAsync(2_000);
  expectPulseCount(pulse as unknown as { mock: { calls: unknown[] } }, 5);

  await leaseB.refresh();
  expectPulseCount(pulse as unknown as { mock: { calls: unknown[] } }, 6);

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
  expectPulseCount(params.pulse as unknown as { mock: { calls: unknown[] } }, 2);

  lease.stop();
}

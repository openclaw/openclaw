import { expect, vi } from "vitest";

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

  expect(pulse).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(2_000);
  expect(pulse).toHaveBeenCalledTimes(4);

  leaseA.stop();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(pulse).toHaveBeenCalledTimes(5);

  await leaseB.refresh();
  expect(pulse).toHaveBeenCalledTimes(6);

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
  expect(params.pulse).toHaveBeenCalledTimes(2);

  lease.stop();
}

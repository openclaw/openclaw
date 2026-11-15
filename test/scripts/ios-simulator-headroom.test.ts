import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { waitForIOSSimulatorHeadroom } from "../../scripts/lib/ios-simulator-headroom.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(sleep).mockReset();
});

function cpuFixture(
  idle: readonly [number, ...number[]],
  options: { firstDelayMs?: number; frozen?: boolean } = {},
) {
  const idleSamples = idle.values();
  let idlePercent = idle[0];
  let elapsed = 0;
  let reads = 0;
  let idleTime = 0;
  let totalTime = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  vi.spyOn(os, "cpus").mockImplementation(() => {
    if (reads++ > 0 && !options.frozen) {
      idlePercent = idleSamples.next().value ?? idlePercent;
      idleTime += idlePercent;
      totalTime += 100;
    }
    return [
      {
        model: "fixture",
        speed: 0,
        times: { idle: idleTime, user: totalTime - idleTime, sys: 0, nice: 0, irq: 0 },
      },
    ];
  });
  vi.mocked(sleep).mockImplementation(async (ms, _value, timerOptions) => {
    timerOptions?.signal?.throwIfAborted();
    elapsed += elapsed === 0 && options.firstDelayMs ? options.firstDelayMs : (ms ?? 1);
  });
}

it.each([30, 80])("requires ten seconds of sustained headroom at %s percent idle", async (idle) => {
  cpuFixture([0, 0, idle]);
  await expect(waitForIOSSimulatorHeadroom(new AbortController().signal)).resolves.toEqual({
    status: "ready",
    elapsedMs: 14_000,
    samples: 7,
    idlePercent: idle,
  });
});

it("restarts the healthy interval after a busy sample", async () => {
  cpuFixture([80, 80, 0, 80]);
  await expect(waitForIOSSimulatorHeadroom(new AbortController().signal)).resolves.toMatchObject({
    status: "ready",
    elapsedMs: 16_000,
  });
});

it("does not treat a delayed observer's long average as sustained headroom", async () => {
  cpuFixture([80], { firstDelayMs: 10_000 });
  await expect(waitForIOSSimulatorHeadroom(new AbortController().signal)).resolves.toMatchObject({
    status: "ready",
    elapsedMs: 20_000,
    samples: 6,
  });
});

it.each([false, true])(
  "times out without usable headroom (frozen counters: %s)",
  async (frozen) => {
    cpuFixture([0], { frozen });
    await expect(waitForIOSSimulatorHeadroom(new AbortController().signal)).resolves.toMatchObject({
      status: "timeout",
      elapsedMs: 300_000,
      samples: 150,
    });
  },
);

it("honors cancellation while waiting for the next CPU sample", async () => {
  cpuFixture([0]);
  const abort = new AbortController();
  vi.mocked(sleep).mockImplementationOnce(async (_ms, _value, timerOptions) => {
    abort.abort();
    timerOptions?.signal?.throwIfAborted();
  });
  await expect(waitForIOSSimulatorHeadroom(abort.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});

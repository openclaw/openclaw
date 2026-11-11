import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readProcessTreeCpuMs,
  startGatewayRssSampling,
} from "../../scripts/lib/gateway-bench-probes.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("gateway benchmark process probes", () => {
  it("leaves an idle interval between slow process measurements", () => {
    vi.useFakeTimers();
    let measurements = 0;
    vi.mocked(spawnSync).mockImplementation(() => {
      measurements++;
      if (measurements < 5) {
        vi.advanceTimersByTime(200);
      }
      return {
        status: 0,
        stdout: process.platform === "win32" ? "1,1048576" : "1024",
      } as never;
    });

    const sampler = startGatewayRssSampling({ pid: 123 });
    try {
      vi.advanceTimersByTime(100);
      expect(measurements).toBe(2);
      expect(sampler.sample()).toBe(1);
    } finally {
      sampler.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(process.platform === "win32")("parses day-prefixed process-tree CPU times", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "123 1 1-02:03:04\n124 123 01:02\n",
    } as never);

    expect(readProcessTreeCpuMs(123)).toBe(93_846_000);
  });
});

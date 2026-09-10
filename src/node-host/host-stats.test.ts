import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { validateNodeHostStatsPayload } from "../../packages/gateway-protocol/src/index.js";
import * as diskSpace from "../infra/disk-space.js";
import { sampleNodeHostStats } from "./host-stats.js";

afterEach(() => vi.restoreAllMocks());

it("samples the real host into the node host stats wire contract", () => {
  const stats = sampleNodeHostStats();
  expect(validateNodeHostStatsPayload(stats)).toBe(true);
  expect(stats.memoryTotalBytes).toBeGreaterThan(0);
  expect(stats.cpuCount).toBeGreaterThanOrEqual(1);
  expect(stats).not.toHaveProperty("updatedAtMs");
});

it("bounds OS readings and reports available space on the home volume", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(os, "cpus").mockReturnValue([]);
  vi.spyOn(os, "loadavg").mockReturnValue([1.25, -1, 100_001]);
  vi.spyOn(os, "totalmem").mockReturnValue(100.4);
  vi.spyOn(process, "availableMemory").mockReturnValue(40);
  const disk = vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue({
    targetPath: os.homedir(),
    checkedPath: os.homedir(),
    totalBytes: 500.4,
    availableBytes: 600,
  });

  const stats = sampleNodeHostStats();
  expect(stats).toEqual({
    cpuCount: 1,
    loadAverage: [1.25, 0, 100_000],
    memoryTotalBytes: 100,
    memoryFreeBytes: 40,
    diskTotalBytes: 500,
    diskAvailableBytes: 500,
  });
  expect(disk).toHaveBeenCalledWith(os.homedir());
  expect(validateNodeHostStatsPayload(stats)).toBe(true);
});

it("falls back to free memory when available memory is unsupported", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "availableMemory").mockReturnValue(0);
  vi.spyOn(os, "freemem").mockReturnValue(4096);
  expect(sampleNodeHostStats().memoryFreeBytes).toBe(4096);
});

it.each(["linux", "win32"] as const)("keeps host-wide memory readings on %s", (platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const availableMemory = vi.spyOn(process, "availableMemory").mockReturnValue(40);
  vi.spyOn(os, "freemem").mockReturnValue(2048);

  expect(sampleNodeHostStats().memoryFreeBytes).toBe(2048);
  expect(availableMemory).not.toHaveBeenCalled();
});

it.each([
  null,
  { targetPath: "/home", checkedPath: "/home", totalBytes: null, availableBytes: 100 },
])("omits unavailable disk capacity and zero-only load averages", (disk) => {
  vi.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue(disk);
  const stats = sampleNodeHostStats();
  expect(validateNodeHostStatsPayload(stats)).toBe(true);
  expect(stats).not.toHaveProperty("loadAverage");
  expect(stats).not.toHaveProperty("diskTotalBytes");
  expect(stats).not.toHaveProperty("diskAvailableBytes");
});

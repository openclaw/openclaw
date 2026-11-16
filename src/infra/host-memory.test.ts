import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { isMemoryPressureHigh } from "./host-memory.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "unbounded Linux host", limit: 0, free: 128, expected: true },
  { name: "Linux sentinel limit", limit: 2 ** 64, free: 128, expected: true },
  { name: "host pressure with process headroom", limit: 1024, free: 128, expected: true },
  { name: "process pressure with host headroom", limit: 1024, available: 128, expected: true },
  { name: "exhausted process allowance", limit: 1024, available: 0, expected: true },
  { name: "healthy host", limit: 0, expected: false },
  { name: "host at the pressure threshold", limit: 0, free: 200, total: 1000, expected: true },
  { name: "host above the pressure threshold", limit: 0, free: 201, total: 1000, expected: false },
  { name: "unknown free memory", limit: 0, free: 0, expected: false },
  { name: "unknown total memory", limit: 0, free: 128, total: 0, expected: false },
  { name: "non-Linux host", limit: 0, free: 128, platform: "darwin" as const, expected: false },
  { name: "Bun host", limit: 0, free: 128, bun: "1.3.0", expected: false },
  { name: "Bun process pressure", limit: 1024, available: 128, bun: "1.3.0", expected: true },
])("detects $name without changing process-limit policy", (sample) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(sample.platform ?? "linux");
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, bun: sample.bun });
  vi.spyOn(process, "constrainedMemory").mockReturnValue(sample.limit);
  vi.spyOn(process, "availableMemory").mockReturnValue(sample.available ?? 1024);
  vi.spyOn(os, "freemem").mockReturnValue(sample.free ?? 1024);
  vi.spyOn(os, "totalmem").mockReturnValue(sample.total ?? 1024);
  expect(isMemoryPressureHigh()).toBe(sample.expected);
});

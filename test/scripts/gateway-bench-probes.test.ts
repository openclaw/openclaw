// Verifies the process probes: `ps` CPU/RSS on Unix, and Windows RSS via a CIM Win32_Process query.
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import {
  parseProcessRssKb,
  readProcessRssMb,
  readProcessTreeCpuMs,
} from "../../scripts/lib/gateway-bench-probes.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function mockSpawn(result: { status: number | null; stdout: string }): void {
  spawnSyncMock.mockReturnValue(result);
}

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  spawnSyncMock.mockReset();
});

describe("parseProcessRssKb", () => {
  it("parses a positive integer", () => {
    expect(parseProcessRssKb(" 144080 \n")).toBe(144_080);
  });

  it("rejects zero, negatives, and non-numeric values", () => {
    expect(parseProcessRssKb("0")).toBeNull();
    expect(parseProcessRssKb("-5")).toBeNull();
    expect(parseProcessRssKb("abc")).toBeNull();
    expect(parseProcessRssKb("")).toBeNull();
  });
});

describe("readProcessRssMb (Unix)", () => {
  it("converts `ps` RSS kilobytes to megabytes", () => {
    setPlatform("linux");
    mockSpawn({ status: 0, stdout: "144080\n" });
    expect(readProcessRssMb(1234)).toBeCloseTo(144_080 / 1024, 5);
  });

  it("returns null when `ps` fails", () => {
    setPlatform("linux");
    mockSpawn({ status: 1, stdout: "" });
    expect(readProcessRssMb(1234)).toBeNull();
  });

  it("returns null for an invalid pid without spawning", () => {
    setPlatform("linux");
    expect(readProcessRssMb(undefined)).toBeNull();
    expect(readProcessRssMb(0)).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe("readProcessTreeCpuMs (Unix)", () => {
  it("sums CPU time across the tree rooted at rootPid", () => {
    setPlatform("linux");
    mockSpawn({
      status: 0,
      stdout: ["100 1 00:10", "200 100 00:05", "300 100 01:00", "400 999 00:30"].join("\n"),
    });
    // 100=10s + 200=5s + 300=60s; 400 belongs to a different parent and is excluded.
    expect(readProcessTreeCpuMs(100)).toBe(75_000);
  });

  it("returns null when the root pid is absent", () => {
    setPlatform("linux");
    mockSpawn({ status: 0, stdout: "200 100 00:05" });
    expect(readProcessTreeCpuMs(999_999)).toBeNull();
  });

  it("returns null when `ps` fails", () => {
    setPlatform("linux");
    mockSpawn({ status: 1, stdout: "" });
    expect(readProcessTreeCpuMs(100)).toBeNull();
  });
});

describe("readProcessRssMb (Windows)", () => {
  it("converts CIM WorkingSetSize bytes to megabytes", () => {
    setPlatform("win32");
    mockSpawn({ status: 0, stdout: "144080896\n" });
    expect(readProcessRssMb(1234)).toBeCloseTo(144_080_896 / (1024 * 1024), 5);
  });

  it("returns null on empty or failed output", () => {
    setPlatform("win32");
    mockSpawn({ status: 0, stdout: "   " });
    expect(readProcessRssMb(1234)).toBeNull();
    mockSpawn({ status: 1, stdout: "" });
    expect(readProcessRssMb(1234)).toBeNull();
  });
});

describe("readProcessTreeCpuMs (Windows)", () => {
  it("is unavailable on Windows (startup CPU comes from the gateway ready trace)", () => {
    setPlatform("win32");
    expect(readProcessTreeCpuMs(100)).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { resolveOsSummary } from "./os-summary.js";

describe("resolveOsSummary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats darwin labels from sw_vers output", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("24.0.0");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    spawnSyncMock.mockReturnValue({
      stdout: " 15.4 \n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });

    expect(resolveOsSummary()).toEqual({
      platform: "darwin",
      arch: "arm64",
      release: "24.0.0",
      label: "macos 15.4 (arm64)",
    });
  });

  it("falls back to os.release when sw_vers output is blank", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("24.1.0");
    vi.spyOn(os, "arch").mockReturnValue("x64");
    spawnSyncMock.mockReturnValue({
      stdout: "   ",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });

    expect(resolveOsSummary().label).toBe("macos 24.1.0 (x64)");
  });

  it("formats windows and non-darwin labels from os metadata", () => {
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    vi.spyOn(os, "arch").mockReturnValue("x64");

    vi.spyOn(os, "platform").mockReturnValue("win32");
    expect(resolveOsSummary().label).toBe("windows 10.0.26100 (x64)");

    vi.spyOn(os, "platform").mockReturnValue("linux");
    expect(resolveOsSummary().label).toBe("linux 10.0.26100 (x64)");
  });
});

// Tests operating system summary collection and normalization.
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

import { resolveMacosProductVersion, resolveOsSummary } from "./os-summary.js";

type OsSummaryCase = {
  name: string;
  platform: ReturnType<typeof os.platform>;
  release: string;
  arch: ReturnType<typeof os.arch>;
  osType: string;
  swVersStdout?: string;
  expected: ReturnType<typeof resolveOsSummary>;
};

describe("resolveOsSummary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<OsSummaryCase>([
    {
      name: "formats darwin labels from sw_vers output",
      platform: "darwin" as const,
      release: "24.0.0",
      arch: "arm64",
      osType: "Darwin",
      swVersStdout: " 15.4 \n",
      expected: {
        platform: "darwin",
        arch: "arm64",
        release: "24.0.0",
        label: "macos 15.4 (arm64)",
        runtimeOsLabel: "macos 15.4",
      },
    },
    {
      name: "falls back to os.release when sw_vers output is blank",
      platform: "darwin" as const,
      release: "24.1.0",
      arch: "x64",
      osType: "Darwin",
      swVersStdout: "   ",
      expected: {
        platform: "darwin",
        arch: "x64",
        release: "24.1.0",
        label: "macos 24.1.0 (x64)",
        runtimeOsLabel: "macos 24.1.0",
      },
    },
    {
      // Regression for #95145: Darwin 25.x (macOS 26 / Tahoe) must map to the
      // sw_vers product version, not be derived from the kernel major (15).
      name: "maps darwin 25 (Tahoe) to the macOS 26 product version",
      platform: "darwin" as const,
      release: "25.5.0",
      arch: "arm64",
      osType: "Darwin",
      swVersStdout: "26.5.1\n",
      expected: {
        platform: "darwin",
        arch: "arm64",
        release: "25.5.0",
        label: "macos 26.5.1 (arm64)",
        runtimeOsLabel: "macos 26.5.1",
      },
    },
    {
      name: "formats windows labels from os metadata",
      platform: "win32" as const,
      release: "10.0.26100",
      arch: "x64",
      osType: "Windows_NT",
      expected: {
        platform: "win32",
        arch: "x64",
        release: "10.0.26100",
        label: "windows 10.0.26100 (x64)",
        runtimeOsLabel: "Windows_NT 10.0.26100",
      },
    },
    {
      name: "formats non-darwin labels from os metadata",
      platform: "linux" as const,
      release: "10.0.26100",
      arch: "x64",
      osType: "Linux",
      expected: {
        platform: "linux",
        arch: "x64",
        release: "10.0.26100",
        label: "linux 10.0.26100 (x64)",
        runtimeOsLabel: "Linux 10.0.26100",
      },
    },
  ])("$name", ({ platform, release, arch, osType, swVersStdout, expected }) => {
    vi.spyOn(os, "platform").mockReturnValue(platform);
    vi.spyOn(os, "release").mockReturnValue(release);
    vi.spyOn(os, "arch").mockReturnValue(arch);
    vi.spyOn(os, "type").mockReturnValue(osType);
    if (platform === "darwin") {
      spawnSyncMock.mockReturnValue({
        stdout: swVersStdout ?? "",
        stderr: "",
        pid: 1,
        output: [],
        status: 0,
        signal: null,
      });
    }
    expect(resolveOsSummary()).toEqual(expected);
  });
});

describe("resolveMacosProductVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the sw_vers product version regardless of the Darwin kernel release (#95145)", () => {
    vi.spyOn(os, "release").mockReturnValue("25.5.0");
    spawnSyncMock.mockReturnValue({
      stdout: "26.5.1\n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });
    expect(resolveMacosProductVersion()).toBe("26.5.1");
  });

  it("falls back to os.release when sw_vers is unavailable", () => {
    vi.spyOn(os, "release").mockReturnValue("25.5.0");
    spawnSyncMock.mockReturnValue({
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
      status: 1,
      signal: null,
    });
    expect(resolveMacosProductVersion()).toBe("25.5.0");
  });
});

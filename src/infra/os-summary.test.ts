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

import { resolveOsRelease, resolveOsSummary, resolveRuntimeOsLabel, _resetOsSummaryCaches } from "./os-summary.js";

describe("resolveOsRelease", () => {
  afterEach(() => {
    _resetOsSummaryCaches();
    vi.restoreAllMocks();
  });

  it("returns sw_vers productVersion on darwin", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("25.5.0");
    spawnSyncMock.mockReturnValue({
      stdout: "26.5.1\n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });
    expect(resolveOsRelease()).toBe("26.5.1");
  });

  it("falls back to os.release on darwin when sw_vers output is blank", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("25.5.0");
    spawnSyncMock.mockReturnValue({
      stdout: "   ",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });
    expect(resolveOsRelease()).toBe("25.5.0");
  });

  it("returns os.release unchanged on linux", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(os, "release").mockReturnValue("6.1.0");
    expect(resolveOsRelease()).toBe("6.1.0");
  });

  it("returns os.release unchanged on win32", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    expect(resolveOsRelease()).toBe("10.0.26100");
  });
});

describe("resolveRuntimeOsLabel", () => {
  afterEach(() => {
    _resetOsSummaryCaches();
    vi.restoreAllMocks();
  });

  it("returns macos label with sw_vers productVersion on darwin", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
    vi.spyOn(os, "release").mockReturnValue("25.5.0");
    spawnSyncMock.mockReturnValue({
      stdout: "26.5.1\n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });
    expect(resolveRuntimeOsLabel()).toBe("macos 26.5.1");
  });

  it("falls back to Darwin kernel version on darwin when sw_vers is blank", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
    vi.spyOn(os, "release").mockReturnValue("25.5.0");
    spawnSyncMock.mockReturnValue({
      stdout: "   ",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });
    expect(resolveRuntimeOsLabel()).toBe("macos 25.5.0");
  });

  it("returns os.type plus os.release on linux", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(os, "type").mockReturnValue("Linux");
    vi.spyOn(os, "release").mockReturnValue("6.1.0");
    expect(resolveRuntimeOsLabel()).toBe("Linux 6.1.0");
  });

  it("returns os.type plus os.release on win32", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    vi.spyOn(os, "type").mockReturnValue("Windows_NT");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    expect(resolveRuntimeOsLabel()).toBe("Windows_NT 10.0.26100");
  });
});

type OsSummaryCase = {
  name: string;
  platform: ReturnType<typeof os.platform>;
  release: string;
  arch: ReturnType<typeof os.arch>;
  swVersStdout?: string;
  expected: ReturnType<typeof resolveOsSummary>;
};

describe("resolveOsSummary", () => {
  afterEach(() => {
    _resetOsSummaryCaches();
    vi.restoreAllMocks();
  });

  it.each<OsSummaryCase>([
    {
      name: "formats darwin labels from sw_vers output and uses productVersion as release",
      platform: "darwin" as const,
      release: "25.5.0",
      arch: "arm64",
      swVersStdout: " 26.5.1 \n",
      expected: {
        platform: "darwin",
        arch: "arm64",
        release: "26.5.1",
        label: "macos 26.5.1 (arm64)",
      },
    },
    {
      name: "falls back to os.release when sw_vers output is blank",
      platform: "darwin" as const,
      release: "24.1.0",
      arch: "x64",
      swVersStdout: "   ",
      expected: {
        platform: "darwin",
        arch: "x64",
        release: "24.1.0",
        label: "macos 24.1.0 (x64)",
      },
    },
    {
      name: "formats windows labels from os metadata",
      platform: "win32" as const,
      release: "10.0.26100",
      arch: "x64",
      expected: {
        platform: "win32",
        arch: "x64",
        release: "10.0.26100",
        label: "windows 10.0.26100 (x64)",
      },
    },
    {
      name: "formats non-darwin labels from os metadata",
      platform: "linux" as const,
      release: "10.0.26100",
      arch: "x64",
      expected: {
        platform: "linux",
        arch: "x64",
        release: "10.0.26100",
        label: "linux 10.0.26100 (x64)",
      },
    },
  ])("$name", ({ platform, release, arch, swVersStdout, expected }) => {
    vi.spyOn(os, "platform").mockReturnValue(platform);
    vi.spyOn(os, "release").mockReturnValue(release);
    vi.spyOn(os, "arch").mockReturnValue(arch);
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

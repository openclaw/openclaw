// Tests operating system summary collection and normalization.
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

import {
  __resetOsSummaryCachesForTests,
  resolveOsSummary,
  resolveRuntimePromptOs,
} from "./os-summary.js";

type OsSummaryCase = {
  name: string;
  platform: ReturnType<typeof os.platform>;
  release: string;
  arch: ReturnType<typeof os.arch>;
  swVersStdout?: string;
  expected: ReturnType<typeof resolveOsSummary>;
};

describe("resolveOsSummary", () => {
  beforeEach(() => {
    __resetOsSummaryCachesForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<OsSummaryCase>([
    {
      name: "formats darwin labels from sw_vers output",
      platform: "darwin" as const,
      release: "24.0.0",
      arch: "arm64",
      swVersStdout: " 15.4 \n",
      expected: {
        platform: "darwin",
        arch: "arm64",
        release: "24.0.0",
        label: "macos 15.4 (arm64)",
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

type RuntimePromptOsCase = {
  name: string;
  platform: ReturnType<typeof os.platform>;
  type: string;
  release: string;
  swVersStdout?: string;
  expected: string;
};

describe("resolveRuntimePromptOs", () => {
  beforeEach(() => {
    __resetOsSummaryCachesForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<RuntimePromptOsCase>([
    {
      name: "renders macOS marketing version on darwin (Tahoe / Darwin 25.x)",
      platform: "darwin" as const,
      type: "Darwin",
      release: "25.5.0",
      swVersStdout: "26.5.1\n",
      expected: "macOS 26.5.1",
    },
    {
      name: "renders macOS marketing version on darwin (Sequoia / Darwin 24.x)",
      platform: "darwin" as const,
      type: "Darwin",
      release: "24.5.0",
      swVersStdout: "15.6\n",
      expected: "macOS 15.6",
    },
    {
      name: "falls back to os.release on darwin when sw_vers returns blank",
      platform: "darwin" as const,
      type: "Darwin",
      release: "25.5.0",
      swVersStdout: "   ",
      expected: "macOS 25.5.0",
    },
    {
      name: "keeps os.type/os.release shape on linux",
      platform: "linux" as const,
      type: "Linux",
      release: "6.10.0-amd64",
      expected: "Linux 6.10.0-amd64",
    },
    {
      name: "keeps os.type/os.release shape on win32",
      platform: "win32" as const,
      type: "Windows_NT",
      release: "10.0.26100",
      expected: "Windows_NT 10.0.26100",
    },
  ])("$name", ({ platform, type, release, swVersStdout, expected }) => {
    vi.spyOn(os, "platform").mockReturnValue(platform);
    vi.spyOn(os, "type").mockReturnValue(type);
    vi.spyOn(os, "release").mockReturnValue(release);
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
    expect(resolveRuntimePromptOs()).toBe(expected);
  });
});

describe("resolveRuntimePromptOs caching", () => {
  beforeEach(() => {
    __resetOsSummaryCachesForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses cached macOS product version across repeated calls (PR #95189 reviewer P1)", () => {
    // Use a kernel release no other test case in this file uses, so the
    // module-level cache miss is exclusively this test's responsibility.
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("25.7.0");
    spawnSyncMock.mockReturnValue({
      stdout: "26.7.0\n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });

    const callsBefore = spawnSyncMock.mock.calls.length;
    const first = resolveRuntimePromptOs();
    const callsAfterFirst = spawnSyncMock.mock.calls.length;
    const second = resolveRuntimePromptOs();
    const third = resolveRuntimePromptOs();
    const callsAfterThird = spawnSyncMock.mock.calls.length;

    expect(first).toBe("macOS 26.7.0");
    expect(second).toBe("macOS 26.7.0");
    expect(third).toBe("macOS 26.7.0");
    // First call must spawn sw_vers exactly once; subsequent calls must reuse
    // the cached product version and not re-spawn the subprocess.
    expect(callsAfterFirst - callsBefore).toBe(1);
    expect(callsAfterThird - callsAfterFirst).toBe(0);
  });

  it("runtime-prompt and os-summary share the cached Darwin product version", () => {
    // Same kernel release across both call paths: the second path must not
    // spawn sw_vers again, because the cache is keyed by os.release().
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("25.8.0");
    vi.spyOn(os, "arch").mockReturnValue("arm64");
    spawnSyncMock.mockReturnValue({
      stdout: "26.8.0\n",
      stderr: "",
      pid: 1,
      output: [],
      status: 0,
      signal: null,
    });

    const callsBefore = spawnSyncMock.mock.calls.length;
    const summaryLabel = resolveOsSummary().label;
    const callsAfterSummary = spawnSyncMock.mock.calls.length;
    const runtimeLabel = resolveRuntimePromptOs();
    const callsAfterRuntime = spawnSyncMock.mock.calls.length;

    expect(summaryLabel).toBe("macos 26.8.0 (arm64)");
    expect(runtimeLabel).toBe("macOS 26.8.0");
    expect(callsAfterSummary - callsBefore).toBe(1);
    // resolveRuntimePromptOs called after resolveOsSummary for the same
    // kernel release must not re-spawn sw_vers — the two helpers share the
    // module-level cachedMacosProductVersionByRelease map.
    expect(callsAfterRuntime - callsAfterSummary).toBe(0);
  });
});

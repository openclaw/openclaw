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

import {
  resolveDarwinProductVersion,
  resolveOsSummary,
  resolveRuntimeOsLabel,
} from "./os-summary.js";

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
});

describe("resolveOsSummary", () => {
  it("formats non-darwin labels from os metadata", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(os, "release").mockReturnValue("6.8.0-generic");
    vi.spyOn(os, "arch").mockReturnValue("x64");
    expect(resolveOsSummary()).toEqual({
      platform: "linux",
      arch: "x64",
      release: "6.8.0-generic",
      label: "linux 6.8.0-generic (x64)",
    });
  });
});

describe("resolveRuntimeOsLabel", () => {
  it("preserves the old Windows os.type/os.release shape", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    vi.spyOn(os, "type").mockReturnValue("Windows_NT");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    vi.spyOn(os, "arch").mockReturnValue("x64");

    expect(resolveRuntimeOsLabel()).toBe("Windows_NT 10.0.26100");
    expect(resolveOsSummary().label).toBe("windows 10.0.26100 (x64)");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("preserves the old Linux os.type/os.release shape", () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(os, "type").mockReturnValue("Linux");
    vi.spyOn(os, "release").mockReturnValue("6.8.0-generic");
    vi.spyOn(os, "arch").mockReturnValue("x64");

    expect(resolveRuntimeOsLabel()).toBe("Linux 6.8.0-generic");
  });

  it("caches the Darwin product version for repeated runtime prompt lookups", () => {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
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

    expect(resolveRuntimeOsLabel()).toBe("macOS 26.8.0");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.8.0");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe("shared OS source facts and independent label outcomes", () => {
  function darwin(release: string) {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
    vi.spyOn(os, "release").mockReturnValue(release);
    vi.spyOn(os, "arch").mockReturnValue("arm64");
  }

  it("keeps an early direct probe failure retryable by later label consumers", () => {
    darwin("90.1.0");
    spawnSyncMock.mockReturnValueOnce({ stdout: " " }).mockReturnValue({ stdout: "26.1\n" });
    expect(resolveDarwinProductVersion()).toBe("90.1.0");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.1");
    expect(resolveOsSummary()).toEqual({
      platform: "darwin",
      arch: "arm64",
      release: "90.1.0",
      label: "macos 26.1 (arm64)",
    });
  });

  it("retains a runtime fallback after a later diagnostic probe succeeds", () => {
    darwin("90.2.0");
    spawnSyncMock
      .mockReturnValueOnce({ stdout: null, error: new Error("probe unavailable") })
      .mockReturnValue({ stdout: "26.2" });
    expect(resolveRuntimeOsLabel()).toBe("macOS 90.2.0");
    expect(resolveOsSummary().label).toBe("macos 26.2 (arm64)");
    expect(resolveRuntimeOsLabel()).toBe("macOS 90.2.0");
    expect(resolveDarwinProductVersion()).toBe("26.2");
  });

  it("retains a diagnostic fallback after a later runtime probe succeeds", () => {
    darwin("90.3.0");
    spawnSyncMock.mockReturnValueOnce({ stdout: "" }).mockReturnValue({ stdout: "26.3" });
    const summary = resolveOsSummary();
    expect(summary.label).toBe("macos 90.3.0 (arm64)");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.3");
    expect(resolveOsSummary()).toBe(summary);
    expect(summary.label).toBe("macos 90.3.0 (arm64)");
  });

  it("does not publish a thrown probe as either label outcome", () => {
    darwin("90.4.0");
    const error = new Error("native probe threw");
    spawnSyncMock
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockReturnValue({ stdout: "26.4" });
    expect(() => resolveRuntimeOsLabel()).toThrow(error);
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.4");
    expect(resolveOsSummary().label).toBe("macos 26.4 (arm64)");
  });

  it("retains the existing nonblank stdout acceptance independently of exit status", () => {
    darwin("90.5.0");
    spawnSyncMock.mockReturnValue({
      stdout: " 26.5\n",
      status: 1,
      signal: null,
      error: new Error("reported error"),
    });
    expect(resolveDarwinProductVersion()).toBe("26.5");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.5");
    expect(resolveOsSummary().label).toBe("macos 26.5 (arm64)");
  });

  it("keeps the mutable summary separate from runtime and source facts", () => {
    darwin("90.6.0");
    spawnSyncMock.mockReturnValue({ stdout: "26.6" });
    const summary = resolveOsSummary();
    expect(Object.keys(summary)).toEqual(["platform", "arch", "release", "label"]);
    summary.label = "caller label";
    summary.release = "caller release";
    summary.arch = "caller arch";
    expect(resolveOsSummary()).toBe(summary);
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.6");
    expect(resolveDarwinProductVersion()).toBe("26.6");
    expect(summary.label).toBe("caller label");
  });

  it("keeps raw platform release and architecture tuple boundaries", () => {
    darwin("90.7.0");
    spawnSyncMock.mockImplementation(() => ({ stdout: os.arch() === "arm64" ? "26.7" : "26.8" }));
    const arm = resolveOsSummary();
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.7");
    vi.mocked(os.arch).mockReturnValue("x64");
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.8");
    expect(resolveOsSummary().label).toBe("macos 26.8 (x64)");
    vi.mocked(os.arch).mockReturnValue("arm64");
    expect(resolveOsSummary()).toBe(arm);
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.7");
  });

  it("shares the first successful product version across later consumers", () => {
    darwin("90.8.0");
    spawnSyncMock.mockReturnValue({ stdout: "26.8" });
    expect(resolveDarwinProductVersion()).toBe("26.8");
    spawnSyncMock.mockReturnValue({ stdout: "27.0" });
    expect(resolveRuntimeOsLabel()).toBe("macOS 26.8");
    expect(resolveOsSummary()).toEqual({
      platform: "darwin",
      arch: "arm64",
      release: "90.8.0",
      label: "macos 26.8 (arm64)",
    });
    expect(resolveDarwinProductVersion()).toBe("26.8");
  });
});

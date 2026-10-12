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
});

describe("shared OS source facts and independent label outcomes", () => {
  function darwin(release: string) {
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    vi.spyOn(os, "type").mockReturnValue("Darwin");
    vi.spyOn(os, "release").mockReturnValue(release);
    vi.spyOn(os, "arch").mockReturnValue("arm64");
  }

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
});

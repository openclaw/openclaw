// Covers TUI Codex CLI lookup command selection.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetWindowsInstallRootsForTests } from "../infra/windows-install-roots.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

import { resolveCodexCliBin } from "./tui.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  execFileSyncMock.mockReset();
  resetWindowsInstallRootsForTests();
});

describe("resolveCodexCliBin", () => {
  it("uses the trusted Windows where.exe when resolving codex", async () => {
    vi.stubEnv("SystemRoot", "D:\\Windows");
    resetWindowsInstallRootsForTests({ queryRegistryValue: () => null });
    execFileSyncMock.mockReturnValue("D:\\Tools\\codex.exe\r\n");

    await withMockedWindowsPlatform(async () => {
      expect(resolveCodexCliBin()).toBe("D:\\Tools\\codex.exe");
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      path.win32.join("D:\\Windows", "System32", "where.exe"),
      ["codex"],
      { encoding: "utf8" },
    );
  });
});

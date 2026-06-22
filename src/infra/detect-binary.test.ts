// Covers host binary detection command selection.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { resetWindowsInstallRootsForTests } from "./windows-install-roots.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

import { detectBinary } from "./detect-binary.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runCommandWithTimeoutMock.mockReset();
  resetWindowsInstallRootsForTests();
});

describe("detectBinary", () => {
  it("uses the trusted Windows where.exe when probing PATH", async () => {
    vi.stubEnv("SystemRoot", "D:\\Windows");
    resetWindowsInstallRootsForTests({ queryRegistryValue: () => null });
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "D:\\Tools\\openclaw.exe\n",
    });

    await withMockedWindowsPlatform(async () => {
      await expect(detectBinary("openclaw")).resolves.toBe(true);
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [path.win32.join("D:\\Windows", "System32", "where.exe"), "openclaw"],
      { timeoutMs: 2000 },
    );
  });
});

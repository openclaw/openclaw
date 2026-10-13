import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runManagedCommand } = vi.hoisted(() => ({ runManagedCommand: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand,
}));

import { main } from "../../scripts/check-changed.mts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runManagedCommand.mockReset();
  process.exitCode = 0;
});

describe("changed-check remote execution", () => {
  it.each([
    "[crabbox] no ready provider for workload=ci-fast\n",
    'request failed: Get "https://backend.blacksmith.example/testbox": context deadline exceeded\n',
    '"errorKind":"command-exit"\n',
    "remote transport lost\n",
  ])("preserves remote failure without starting local checks: %s", async (output) => {
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("OPENCLAW_TESTBOX", "1");
    vi.stubEnv("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD", "");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    runManagedCommand.mockImplementationOnce(async (options) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      options.onReady({ stdout, stderr });
      stderr.emit("data", Buffer.from(output));
      return 7;
    });

    await main(["--staged", "--", "README.md"]);

    expect(process.exitCode).toBe(7);
    expect(runManagedCommand).toHaveBeenCalledTimes(1);
    expect(runManagedCommand.mock.calls[0]?.[0].args[0]).toBe("scripts/crabbox-wrapper.mjs");
  });
});

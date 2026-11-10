import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runManagedCommand, listChangedPathsFromGit, findTypecheckInertPaths } = vi.hoisted(() => ({
  runManagedCommand: vi.fn(),
  listChangedPathsFromGit: vi.fn(),
  findTypecheckInertPaths: vi.fn(),
}));
vi.mock("../../scripts/changed-lanes.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/changed-lanes.mts")>()),
  listChangedPathsFromGit,
}));
vi.mock("../../scripts/lib/typecheck-inert.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/typecheck-inert.mts")>()),
  findTypecheckInertPaths,
}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand,
}));

import { main } from "../../scripts/check-changed.mts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runManagedCommand.mockReset();
  listChangedPathsFromGit.mockReset();
  findTypecheckInertPaths.mockReset();
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

describe("changed-check trivia classification ownership", () => {
  it.each(["remote", "local", "remote-child"] as const)(
    "classifies only in the executing %s branch",
    async (route) => {
      const file = "src/shared/account-enabled.test.ts";
      vi.stubEnv("CI", "");
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("OPENCLAW_TESTBOX", route === "local" ? "" : "1");
      vi.stubEnv("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD", route === "remote-child" ? "1" : "");
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      listChangedPathsFromGit.mockReturnValue([file]);
      findTypecheckInertPaths.mockReturnValue([file]);
      runManagedCommand.mockResolvedValue(0);

      await main(["--base", "HEAD"]);

      expect(process.exitCode).toBe(0);
      expect(listChangedPathsFromGit).toHaveBeenCalledWith({ base: "HEAD", head: "HEAD" });
      if (route === "remote") {
        expect(findTypecheckInertPaths).not.toHaveBeenCalled();
        expect(runManagedCommand).toHaveBeenCalledTimes(1);
        expect(runManagedCommand.mock.calls[0]?.[0].args).toEqual(
          expect.arrayContaining(["scripts/crabbox-wrapper.mjs", "--base", "HEAD"]),
        );
      } else {
        expect(findTypecheckInertPaths).toHaveBeenCalledExactlyOnceWith({
          paths: [file],
          base: "HEAD",
        });
        const commands = runManagedCommand.mock.calls.map(([options]) => options.args);
        expect(commands.some((args) => args.includes("scripts/crabbox-wrapper.mjs"))).toBe(false);
        expect(commands.some((args) => args.includes("check:no-conflict-markers"))).toBe(true);
        expect(commands.some((args) => args.includes("format:check") && args.includes(file))).toBe(
          true,
        );
        expect(
          commands.some((args) => args.includes("scripts/run-oxlint.mjs") && args.includes(file)),
        ).toBe(true);
        expect(
          commands.some((args) => args.some((arg: string) => /tsgo|plugin-boundary/.test(arg))),
        ).toBe(false);
      }
    },
  );
});

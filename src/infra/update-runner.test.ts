import path from "node:path";
import { expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import * as updateGlobal from "./update-global.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import { resolveUpdateInstallSurface } from "./update-runner-install-surface.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"),
}));

it("owns default updater subprocess trees", async () => {
  using runCommandWithTimeout = vi
    .spyOn(exec, "runCommandWithTimeout")
    .mockResolvedValue(createCommandResult());
  using _ = vi
    .spyOn(updateGlobal, "createGlobalInstallEnv")
    .mockResolvedValue({ OPENCLAW_UPDATE_TEST_ENV: "1" });
  const { runCommand } = await buildUpdateCommandRunner();
  const cwd = process.cwd();
  await runCommand(["pnpm", "install"], { cwd, timeoutMs: 500 });
  expect(runCommandWithTimeout).toHaveBeenCalledWith(["pnpm", "install"], {
    cwd,
    env: { OPENCLAW_UPDATE_TEST_ENV: "1" },
    killProcessTree: true,
    timeoutMs: 500,
  });
});

it.each(["git", "package"] as const)(
  "preserves prepared %s roots without Git probes",
  async (installKind) => {
    const root = path.resolve("prepared", installKind);
    const responses: Record<string, string> = {
      "npm root -g": path.resolve("npm-global"),
      "pnpm root -g": path.resolve("pnpm-global"),
    };
    const runCommand = vi.fn(async (argv: string[]) => {
      const stdout = responses[argv.join(" ")];
      if (installKind === "git" || stdout === undefined) {
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      }
      return { stdout, stderr: "", code: 0 };
    });
    await expect(
      resolveUpdateInstallSurface({ root, installKind, timeoutMs: 1000, runCommand }),
    ).resolves.toEqual({
      kind: installKind === "git" ? "git" : "package-root",
      mode: installKind === "git" ? "git" : "unknown",
      root,
      packageRoot: root,
    });
    expect(runCommand.mock.calls.map(([argv]) => argv.join(" "))).toEqual(
      installKind === "git" ? [] : ["npm root -g", "pnpm root -g"],
    );
  },
);

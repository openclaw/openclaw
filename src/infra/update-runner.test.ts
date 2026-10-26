import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveUpdateInstallSurface } from "./update-runner-install-surface.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"),
}));

it("owns default updater subprocess trees", async () => {
  const runCommandWithTimeout = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
  vi.resetModules();
  vi.doMock("../process/exec.js", () => ({ runCommandWithTimeout }));
  vi.doMock("./update-global.js", () => ({
    createGlobalInstallEnv: async () => ({ OPENCLAW_UPDATE_TEST_ENV: "1" }),
  }));
  try {
    const { buildUpdateCommandRunner } = await import("./update-runner-command.js");
    const { runCommand } = await buildUpdateCommandRunner();
    const cwd = process.cwd();
    await runCommand(["pnpm", "install"], { cwd, timeoutMs: 500 });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(["pnpm", "install"], {
      cwd,
      env: { OPENCLAW_UPDATE_TEST_ENV: "1" },
      killProcessTree: true,
      timeoutMs: 500,
    });
  } finally {
    vi.doUnmock("../process/exec.js");
    vi.doUnmock("./update-global.js");
    vi.resetModules();
  }
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

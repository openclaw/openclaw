import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { resolveUpdateInstallSurface } from "./update-runner-install-surface.js";

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-update-surface-" });
const execFileSyncMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: execFileSyncMock,
}));
type CommandResponse = { stdout?: string; stderr?: string; code?: number | null };
function toCommandResult(response?: CommandResponse) {
  return {
    stdout: response?.stdout ?? "",
    stderr: response?.stderr ?? "",
    code: response?.code === undefined ? 0 : response.code,
  };
}
function createRunner(responses: Record<string, CommandResponse>) {
  const calls: string[] = [];
  const runner = async (argv: string[]) => {
    const key = argv.join(" ");
    calls.push(key);
    return toCommandResult(responses[key]);
  };
  return { runner, calls };
}

describe("update install surface and command ownership", () => {
  let tempDir: string;
  beforeAll(() => fixtureRootTracker.setup());
  afterAll(() => fixtureRootTracker.cleanup());
  beforeEach(async () => {
    execFileSyncMock.mockClear();
    tempDir = await fixtureRootTracker.make("case");
  });
  it("owns default updater subprocess trees", async () => {
    const runCommandWithTimeoutMock = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
      signal: null,
    }));
    vi.resetModules();
    vi.doMock("../process/exec.js", () => ({ runCommandWithTimeout: runCommandWithTimeoutMock }));
    vi.doMock("./update-global.js", () => ({
      createGlobalInstallEnv: async () => ({ OPENCLAW_UPDATE_TEST_ENV: "1" }),
    }));

    try {
      const { buildUpdateCommandRunner } = await import("./update-runner-command.js");
      const { runCommand } = await buildUpdateCommandRunner();

      await runCommand(["pnpm", "install"], { cwd: tempDir, timeoutMs: 500 });

      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["pnpm", "install"], {
        cwd: tempDir,
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

  it.runIf(process.platform !== "win32")(
    "classifies a prepared pnpm v11-layout project by its canonical package root",
    async () => {
      const globalRoot = path.join(tempDir, "pnpm-home", "global", "v11");
      const installDir = path.join(globalRoot, "install-a");
      const packageRoot = path.join(installDir, "node_modules", "openclaw");
      const storeRoot = path.join(tempDir, "pnpm-home", "store", "v11", "links", "openclaw");
      await fs.mkdir(path.dirname(packageRoot), { recursive: true });
      await fs.mkdir(storeRoot, { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(installDir, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
          "utf8",
        ),
        fs.writeFile(
          path.join(storeRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "1.0.0" }),
          "utf8",
        ),
      ]);
      await Promise.all([
        fs.symlink(storeRoot, packageRoot, "dir"),
        fs.symlink(installDir, path.join(globalRoot, "hash-openclaw"), "dir"),
      ]);

      const runCommand = async (argv: string[]) => {
        const command = argv.join(" ");
        if (command.startsWith("git -C ")) {
          return toCommandResult({ code: 1 });
        }
        if (command === "npm root -g") {
          return toCommandResult({ stdout: `${path.join(tempDir, "npm", "node_modules")}\n` });
        }
        if (command === "pnpm root -g") {
          return toCommandResult({ stdout: `${globalRoot}\n` });
        }
        throw new Error(`unexpected command: ${command}`);
      };

      await expect(
        resolveUpdateInstallSurface({
          root: packageRoot,
          installKind: "package",
          timeoutMs: 1000,
          runCommand,
        }),
      ).resolves.toMatchObject({
        kind: "global",
        mode: "pnpm",
        root: packageRoot,
        packageRoot,
      });
    },
  );

  it("uses a prepared Git checkout without probing process artifacts again", async () => {
    const sourceRoot = path.join(tempDir, "source");
    const { runner, calls } = createRunner({});

    await expect(
      resolveUpdateInstallSurface({
        root: sourceRoot,
        installKind: "git",
        timeoutMs: 1000,
        runCommand: runner,
      }),
    ).resolves.toMatchObject({
      kind: "git",
      mode: "git",
      root: sourceRoot,
      packageRoot: sourceRoot,
    });
    expect(calls).toEqual([]);
  });

  it("preserves non-global package roots without probing Git or the process cwd", async () => {
    const root = path.join(tempDir, "standalone-package");
    const { runner, calls } = createRunner({
      "npm root -g": { stdout: path.join(tempDir, "npm-global") },
      "pnpm root -g": { stdout: path.join(tempDir, "pnpm-global") },
    });

    await expect(
      resolveUpdateInstallSurface({ root, installKind: "package", runCommand: runner }),
    ).resolves.toEqual({ kind: "package-root", mode: "unknown", root, packageRoot: root });
    expect(calls).toEqual(["npm root -g", "pnpm root -g"]);
  });
});

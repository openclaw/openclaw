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
function createRunner(responses: Record<string, string>) {
  return vi.fn(async (argv: string[]) => {
    const key = argv.join(" ");
    const stdout = responses[key];
    if (stdout === undefined) {
      throw new Error(`unexpected command: ${key}`);
    }
    return { stdout, stderr: "", code: 0 };
  });
}

describe("update install surface and command ownership", () => {
  let tempDir: string;
  beforeAll(() => fixtureRootTracker.setup());
  afterAll(() => fixtureRootTracker.cleanup());
  beforeEach(async () => {
    execFileSyncMock.mockClear();
    tempDir = await fixtureRootTracker.make("case");
  });
  const writePackage = (root: string, manifest: object) =>
    fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest), "utf8");
  const resolveSurface = (
    root: string,
    installKind: "git" | "package",
    runCommand: ReturnType<typeof createRunner>,
  ) => resolveUpdateInstallSurface({ root, installKind, timeoutMs: 1000, runCommand });
  it("owns default updater subprocess trees", async () => {
    const runCommandWithTimeoutMock = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
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
        writePackage(installDir, { private: true, dependencies: { openclaw: "1.0.0" } }),
        writePackage(storeRoot, { name: "openclaw", version: "1.0.0" }),
      ]);
      await Promise.all([
        fs.symlink(storeRoot, packageRoot, "dir"),
        fs.symlink(installDir, path.join(globalRoot, "hash-openclaw"), "dir"),
      ]);

      const runner = createRunner({
        "npm root -g": `${path.join(tempDir, "npm", "node_modules")}\n`,
        "pnpm root -g": `${globalRoot}\n`,
      });

      await expect(resolveSurface(packageRoot, "package", runner)).resolves.toMatchObject({
        kind: "global",
        mode: "pnpm",
        root: packageRoot,
        packageRoot,
      });
    },
  );

  it.each(["git", "package"] as const)(
    "preserves prepared %s roots without Git probes",
    async (installKind) => {
      const root = path.join(tempDir, installKind);
      const responses = {
        "npm root -g": path.join(tempDir, "npm-global"),
        "pnpm root -g": path.join(tempDir, "pnpm-global"),
      };
      const runner = createRunner(installKind === "git" ? {} : responses);
      await expect(resolveSurface(root, installKind, runner)).resolves.toEqual({
        kind: installKind === "git" ? "git" : "package-root",
        mode: installKind === "git" ? "git" : "unknown",
        root,
        packageRoot: root,
      });
      expect(runner.mock.calls.map(([argv]) => argv.join(" "))).toEqual(
        installKind === "git" ? [] : ["npm root -g", "pnpm root -g"],
      );
    },
  );
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as diskSpace from "../../infra/disk-space.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runFixtureGit as git } from "../../infra/update-runner-git-candidate.test-support.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { writeOpenClawPackageFixture } from "./update-cli-package.test-support.js";
import { updateGitInstall } from "./update-command-git.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { current: true, runtimeReady: true, backupShortfall: false },
  { current: true, runtimeReady: false, backupShortfall: false },
  { current: false, runtimeReady: true, backupShortfall: true },
])(
  "checks snapshot space after the Git no-op decision (current=$current, runtimeReady=$runtimeReady, backupShortfall=$backupShortfall)",
  async ({ current, runtimeReady, backupShortfall }) => {
    const noOp = current && runtimeReady;
    await withTestDir({ prefix: "git-update-snapshot-" }, async (base) => {
      const root = path.join(base, "checkout");
      const stateDir = path.join(base, "state");
      await fs.mkdir(root);
      await fs.mkdir(stateDir);
      const env = {
        HOME: base,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        TMPDIR: base,
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
      );
      await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n");
      await fs.writeFile(path.join(root, ".gitignore"), "dist/\nnode_modules/\n.artifacts/\n");
      await git(root, "init", "--initial-branch=main");
      await git(root, "config", "user.name", "OpenClaw Test");
      await git(root, "config", "user.email", "openclaw@example.com");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "fixture");
      const before = await git(root, "rev-parse", "HEAD");
      if (runtimeReady) {
        await writeOpenClawPackageFixture(root, "2026.9.1", { builtSha: before });
      }
      let target = before;
      if (!current) {
        await fs.writeFile(path.join(root, "candidate.txt"), "candidate\n");
        await git(root, "add", "candidate.txt");
        await git(root, "commit", "-m", "candidate");
        target = await git(root, "rev-parse", "HEAD");
        await git(root, "checkout", "--detach", before);
      }
      if (backupShortfall) {
        const file = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
        await fs.mkdir(path.dirname(file), { recursive: true });
        using db = openNodeSqliteDatabase(file);
        db.exec(
          "CREATE TABLE evidence(value BLOB); INSERT INTO evidence VALUES(zeroblob(16777216))",
        );
      }
      const capacity = vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
        targetPath,
        checkedPath: targetPath,
        availableBytes: backupShortfall
          ? (targetPath === path.join(root, ".artifacts") ? 100 : 160) * 1024 ** 2
          : 0,
        totalBytes: 1024 ** 3,
      }));
      const runCommand = processRunner.runCommandWithTimeout;
      const candidateCommand = vi.fn(() =>
        createCommandResult({ stderr: "unexpected candidate command", code: 1 }),
      );
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation((argv, options) =>
        argv[0] === "git" ? runCommand(argv, options) : Promise.resolve(candidateCommand()),
      );
      const allocate = vi.spyOn(fs, "mkdtemp");
      const beforeGitMutation = vi.fn();
      const validateCandidate = vi.fn();
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const capacityStep = { name: "snapshot-space-preflight", exitCode: 1 };
      const originalArgv = process.argv;
      process.argv = [process.execPath, path.join(root, "openclaw.mjs")];
      try {
        const result = await updateGitInstall({
          root,
          switchToGit: false,
          installKind: "git",
          timeoutMs: undefined,
          startedAt: Date.now(),
          progress: {},
          channel: "dev",
          devTarget: { mode: "detached", ref: target },
          beforeGitMutation,
          validateCandidate,
          inspectGitTarget: async () => {},
          getManagedServiceEnv: () => undefined,
          getSnapshotSource: async () => ({ config: {}, env }),
          jsonMode: true,
        });
        expect(result).toMatchObject(
          noOp
            ? { status: "skipped", reason: "already-current" }
            : { status: "error", reason: "snapshot-capacity-insufficient" },
        );
        if (!noOp) {
          expect(result.steps).toContainEqual(
            expect.objectContaining({
              ...capacityStep,
              snapshotCapacity: expect.objectContaining({
                reason: "snapshot-capacity-insufficient",
              }),
            }),
          );
        }
        expect(capacity.mock.calls.length === 0).toBe(noOp);
        expect(
          allocate.mock.calls.some(
            ([prefix]) => prefix.includes("update-preflight-") || prefix.includes("ocu-pf-"),
          ),
        ).toBe(false);
        expect(
          [candidateCommand, beforeGitMutation, validateCandidate].map((fn) => fn.mock.calls),
        ).toEqual([[], [], []]);
        expect(await git(root, "rev-parse", "HEAD")).toBe(before);
        expect((await fs.readdir(stateDir)).toSorted()).toEqual(
          backupShortfall ? ["agents", "openclaw.json"] : ["openclaw.json"],
        );
      } finally {
        process.argv = originalArgv;
      }
    });
  },
);

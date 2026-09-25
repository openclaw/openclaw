import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandRunner from "../../process/exec-runner.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin?.end(input);
  });
}

describe("ManagedWorktreeService snapshot index", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  beforeEach(async () => {
    const root = tempDirs.make("openclaw-worktree-index-");
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({ env });
  });
  async function materializeDownstreamFixture(name: string) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now: Date.now(),
      repoRoot: repo,
      stateDir,
    });
  }

  it("captures same-stat racy edits without modifying the checkout index", async () => {
    const created = await materializeDownstreamFixture("racy-snapshot");
    await git(created.path, "update-index", "--index-version=2");
    const index = path.resolve(
      created.path,
      await git(created.path, "rev-parse", "--git-path", "index"),
    );
    const bytes = await fs.readFile(index);
    const file = path.join(created.path, "README.md");
    await fs.writeFile(file, "edit\n"); // Same length as the committed "base\n".
    await fs.utimes(file, 1_600_000_000, 1_600_000_000);
    const stat = await fs.stat(file, { bigint: true });
    // Model an edit within the filesystem's timestamp resolution: cache stat
    // fields match the edit, but its blob still names the old content. Git's
    // index timestamp must force a content check even when every stat matches.
    expect(bytes.readUInt32BE(8)).toBe(1);
    for (const [offset, value] of [
      [0, stat.ctimeNs / 1_000_000_000n],
      [4, stat.ctimeNs % 1_000_000_000n],
      [8, stat.mtimeNs / 1_000_000_000n],
      [12, stat.mtimeNs % 1_000_000_000n],
    ] as const) {
      bytes.writeUInt32BE(Number(BigInt.asUintN(32, value)), 12 + offset);
    }
    const algorithm = await git(created.path, "rev-parse", "--show-object-format");
    const hashBytes = algorithm === "sha256" ? 32 : 20;
    createHash(algorithm)
      .update(bytes.subarray(0, -hashBytes))
      .digest()
      .copy(bytes, bytes.length - hashBytes);
    await fs.writeFile(index, bytes);
    await fs.utimes(index, 1_600_000_000, 1_600_000_000);
    const run = commandRunner.runCommandWithTimeout;
    let checkedIndex = false;
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const argv = args[0];
      if (argv[0] === "git" && argv.includes("worktree") && argv.includes("remove")) {
        expect(await fs.readFile(index)).toEqual(bytes);
        checkedIndex = true;
      }
      return await run(...args);
    });
    const removed = await service.remove({ id: created.id, reason: "test" });
    expect(checkedIndex).toBe(true);
    expect(await git(repo, "show", `${removed.snapshotRef}:README.md`)).toBe("edit");
  });

  it.each(["split", "missing", "unmerged", "sparse", "relaxed-stat"])(
    "snapshots working contents with a %s source index",
    async (kind) => {
      for (const directory of ["included", "excluded"]) {
        await fs.mkdir(path.join(repo, directory));
        await fs.writeFile(path.join(repo, directory, "file.txt"), `${directory} original\n`);
      }
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "add snapshot directories");
      const created = await materializeDownstreamFixture(`index-${kind}`);
      const originalHead = await git(created.path, "rev-parse", "HEAD");
      if (kind === "sparse") {
        await git(created.path, "sparse-checkout", "set", "--cone", "--sparse-index", "included");
      }
      await fs.writeFile(path.join(created.path, "README.md"), "staged content\n");
      await git(created.path, "add", "README.md");
      if (kind === "split") {
        await git(created.path, "update-index", "--split-index");
      } else if (kind === "missing") {
        const index = await git(created.path, "rev-parse", "--git-path", "index");
        await fs.rm(path.resolve(created.path, index));
      } else if (kind === "unmerged") {
        const base = await git(created.path, "rev-parse", "HEAD:README.md");
        const staged = await git(created.path, "rev-parse", ":README.md");
        const other = await gitWithInput(created.path, ["hash-object", "-w", "--stdin"], "other\n");
        await gitWithInput(
          created.path,
          ["update-index", "--index-info"],
          `0 ${"0".repeat(base.length)}\tREADME.md\n` +
            `100644 ${base} 1\tREADME.md\n100644 ${staged} 2\tREADME.md\n100644 ${other} 3\tREADME.md\n`,
        );
      } else if (kind === "relaxed-stat") {
        await git(created.path, "config", "core.trustctime", "false");
        await git(created.path, "config", "core.checkStat", "minimal");
        await git(created.path, "config", "core.ignoreStat", "true");
      }
      await fs.writeFile(path.join(created.path, "README.md"), "current working contents\n");
      const removed = await service.remove({ id: created.id, reason: "test" });
      expect(await git(repo, "show", `${removed.snapshotRef}:README.md`)).toBe(
        "current working contents",
      );
      expect(await git(repo, "show", `${removed.snapshotRef}:excluded/file.txt`)).toBe(
        "excluded original",
      );
      const restored = await service.restore({ id: created.id });
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
      expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
        "current working contents\n",
      );
    },
  );
});

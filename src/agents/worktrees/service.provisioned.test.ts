import { deepStrictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants as fsConstants, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../../test/helpers/promise.js";
import * as gitExec from "../../infra/git-exec.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import * as commandRunner from "../../process/exec-runner.js";
import * as commandSpawner from "../../process/exec-spawn.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import * as worktreeGit from "./git.js";
import { provisionIncludedFiles } from "./provisioned-files.js";
import * as provisionedSnapshots from "./provisioned-snapshot-store.js";
import { insertRegistryWorktreeProvisionedChunk } from "./provisioned-snapshot.test-support.js";
import { getRegistryWorktreeProvisionedChunk } from "./registry-read.js";
import {
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  insertRegistryWorktree,
} from "./registry.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function initializeRepository(root: string, gitTemplate: string): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main", `--template=${gitTemplate}`);
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  // The template is copied recursively; background maintenance can unlink files mid-copy.
  await git(repo, "config", "maintenance.auto", "false");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}

async function addRemote(root: string, repo: string): Promise<void> {
  const remote = path.join(root, "remote.git");
  await execFileAsync("git", ["clone", "--bare", repo, remote]);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "-a");
}

describe("ManagedWorktreeService provisioned state", () => {
  let templateRoot: string;
  let templateRepo: string;
  let gitTemplate: string;
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;
  let receipts: FixtureReceiptChannel;

  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
    const tempRoot = await fs.realpath(os.tmpdir());
    templateRoot = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-state-template-"));
    gitTemplate = path.join(templateRoot, "git-template");
    await fs.mkdir(path.join(gitTemplate, "hooks"), { recursive: true });
    templateRepo = await initializeRepository(templateRoot, gitTemplate);
  });

  afterAll(async () => {
    await receipts.close();
    await fs.rm(templateRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-state-"));
    repo = path.join(root, "repo");
    await fs.cp(templateRepo, repo, { mode: fsConstants.COPYFILE_FICLONE, recursive: true });
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("provisions only manifest-selected ignored files beside a dependency tree under a reduced output cap", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "dependencies/\n.env.local\n");
    await fs.writeFile(
      path.join(repo, ".worktreeinclude"),
      ".env.local\nvisible.local\nREADME.md\ndependencies/package/*.local\n!dependencies/package/excluded.local\n",
    );
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure bounded provisioning");
    const dependencies = path.join(repo, "dependencies", "package");
    await fs.mkdir(dependencies, { recursive: true });
    for (let index = 0; index < 64; index++) {
      await fs.writeFile(
        path.join(dependencies, "generated-dependency-file-" + index + ".txt"),
        "",
      );
    }
    await fs.writeFile(path.join(dependencies, "settings.local"), "nested provisioned\n");
    await fs.writeFile(path.join(dependencies, "excluded.local"), "excluded\n");
    await fs.writeFile(path.join(repo, ".env.local"), "synthetic provisioned\n", { mode: 0o640 });
    await fs.writeFile(path.join(repo, "visible.local"), "not ignored\n");
    const realRun = worktreeGit.runGitBuffered;
    const capped = vi
      .spyOn(worktreeGit, "runGitBuffered")
      .mockImplementation(async (cwd, args, options) => {
        if (cwd === repo && args.includes("ls-files") && args.includes("--ignored")) {
          return await realRun(cwd, args, { ...options, maxOutputBytes: 256 });
        }
        return await realRun(cwd, args, options);
      });
    try {
      // Exercise the typed worker used for capacity estimates, then the registered service flow.
      const inspection = await runGitWorkerOperation({
        type: "worktree.provisioning-inspection",
        input: { sourceRoot: repo },
      });
      expect(inspection).toEqual({
        paths: [".env.local", "dependencies/package/settings.local"],
        estimatedBytes: 8192,
      });
      const created = await service.create({
        repoRoot: repo,
        name: "dependencies",
        baseRef: "HEAD",
      });
      expect(await getRegistryWorktreeProvisionedPaths(env, created.id)).toEqual(inspection.paths);
      expect(await fs.readFile(path.join(created.path, ".env.local"), "utf8")).toBe(
        "synthetic provisioned\n",
      );
      expect((await fs.stat(path.join(created.path, ".env.local"))).mode & 0o777).toBe(
        (await fs.stat(path.join(repo, ".env.local"))).mode & 0o777,
      );
      expect(
        await fs.readFile(path.join(created.path, "dependencies/package/settings.local"), "utf8"),
      ).toBe("nested provisioned\n");
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      expect(await fs.readdir(path.join(created.path, "dependencies/package"))).toEqual([
        "settings.local",
      ]);
      await expect(fs.stat(path.join(created.path, "visible.local"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      // Only paths actually created are returned; an existing checkout file is not owned.
      const destination = path.join(root, "destination");
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, ".env.local"), "destination-owned\n");
      expect(await provisionIncludedFiles(repo, destination)).toEqual([
        "dependencies/package/settings.local",
      ]);
      expect(await fs.readFile(path.join(destination, ".env.local"), "utf8")).toBe(
        "destination-owned\n",
      );
    } finally {
      capped.mockRestore();
    }
  });

  it.each([undefined, "dependencies/\n!dependencies/\n"])(
    "does not broaden empty manifest selections (%s)",
    async (manifest) => {
      await fs.writeFile(path.join(repo, ".gitignore"), "dependencies/\n");
      await fs.mkdir(path.join(repo, "dependencies"));
      await fs.writeFile(path.join(repo, "dependencies/unrelated"), "unrelated\n");
      if (manifest !== undefined) {
        await fs.writeFile(path.join(repo, ".worktreeinclude"), manifest);
      }
      const commands = vi.spyOn(worktreeGit, "runGitBuffered");
      try {
        expect(
          await runGitWorkerOperation({
            type: "worktree.provisioning-inspection",
            input: { sourceRoot: repo },
          }),
        ).toEqual({ paths: [], estimatedBytes: 0 });
        const reads = commands.mock.calls.filter(([, args]) => args.includes("ls-files"));
        expect(reads).toHaveLength(manifest === undefined ? 0 : 1);
        expect(reads.some(([, args]) => args.includes("--exclude-standard"))).toBe(false);
      } finally {
        commands.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "batches supported literal UTF-8 paths without expanding wildcard or magic names",
    async () => {
      await fs.writeFile(path.join(repo, ".gitignore"), "*.local\n");
      await fs.writeFile(
        path.join(repo, ".worktreeinclude"),
        "*.local\n!literalZ.local\n!unselected.local\n",
      );
      await git(repo, "add", ".gitignore", ".worktreeinclude");
      await git(repo, "commit", "-m", "configure literal batches");
      const names = [
        "-leading.local",
        ":(glob)**.local",
        "literal*.local",
        "white space.local",
        "new\nline.local",
        ...Array.from({ length: 140 }, (_, i) => "short-" + String(i).padStart(3, "0") + ".local"),
        ...Array.from(
          { length: 140 },
          (_, i) => "utf8-" + String(i).padStart(3, "0") + "-" + "界".repeat(60) + ".local",
        ),
      ].toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const name of [...names, "literalZ.local", "unselected.local"]) {
        await fs.writeFile(path.join(repo, name), "bytes:" + name);
      }
      const commands = vi.spyOn(gitExec, "executeGitCommandBuffered");
      try {
        expect(
          await runGitWorkerOperation({
            type: "worktree.provisioning-inspection",
            input: { sourceRoot: repo },
          }),
        ).toEqual({ paths: names, estimatedBytes: names.length * 4096 });
        const batches = commands.mock.calls
          .filter(([, args]) => args.includes("ls-files") && args.includes("--exclude-standard"))
          .map(([, args]) => {
            expect(args).toContain("--literal-pathspecs");
            expect(args).toContain("--");
            return args.slice(args.indexOf("--") + 1);
          });
        expect(batches.flat()).toEqual(names);
        expect(batches.some((batch) => batch.length === 128)).toBe(true);
        expect(
          batches.some(
            (batch) =>
              batch.length < 128 &&
              batch.reduce((bytes, entry) => bytes + Buffer.byteLength(entry) + 1, 0) >= 16_384,
          ),
        ).toBe(true);
        for (const batch of batches) {
          expect(batch.length).toBeGreaterThan(0);
          expect(batch.length).toBeLessThanOrEqual(128);
          expect(
            batch.slice(0, -1).reduce((bytes, entry) => bytes + Buffer.byteLength(entry) + 1, 0),
          ).toBeLessThan(16_384);
        }
        const created = await service.create({
          repoRoot: repo,
          name: "literal-batches",
          baseRef: "HEAD",
        });
        expect(await getRegistryWorktreeProvisionedPaths(env, created.id)).toEqual(
          names.toSorted(),
        );
        await expect(fs.stat(path.join(created.path, "literalZ.local"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.stat(path.join(created.path, "unselected.local"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        commands.mockClear();
        const guard = vi.fn();
        await service.remove({ id: created.id, reason: "test", commitGuard: guard });
        const states = await getRegistryWorktreeProvisionedState(env, created.id);
        expect(states?.map((state) => state.path)).toEqual(names.toSorted());
        expect(guard).toHaveBeenCalled();
        const membership = commands.mock.calls.filter(
          ([, args]) =>
            args.includes("--literal-pathspecs") &&
            (args.includes("ls-files") || args.includes("ls-tree")) &&
            args.includes("--"),
        );
        expect(membership.length).toBe(batches.length * 3);
        for (const call of membership) {
          const options = call[2];
          expect(options?.killProcessTree).toBe(true);
          expect(options?.beforeRun).toEqual(expect.any(Function));
        }
        const restored = await service.restore({ id: created.id });
        for (const name of names.slice(0, 5)) {
          expect(await fs.readFile(path.join(restored.path, name), "utf8")).toBe("bytes:" + name);
        }
      } finally {
        commands.mockRestore();
      }
    },
  );

  it("rejects a manifest symlink resolving to a directory", async () => {
    const target = path.join(repo, "manifest-directory");
    await fs.mkdir(target);
    await fs.symlink(target, path.join(repo, ".worktreeinclude"), "junction");
    await expect(
      runGitWorkerOperation({
        type: "worktree.provisioning-inspection",
        input: { sourceRoot: repo },
      }),
    ).rejects.toThrow();
  });

  it("reuses snapshot inventories while round-tripping Git and provisioned contents", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "settings.local\nignored/\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "settings.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure provisioned snapshot");
    await fs.writeFile(path.join(repo, "settings.local"), "synthetic source\n");
    const created = await service.create({ repoRoot: repo, name: "inventory", baseRef: "HEAD" });
    await fs.writeFile(path.join(created.path, "README.md"), "edited tracked content\n");
    await fs.writeFile(path.join(created.path, "untracked.txt"), "new content\n");
    await fs.writeFile(path.join(created.path, "settings.local"), "synthetic local\n");
    await fs.mkdir(path.join(created.path, "ignored"));
    await fs.writeFile(path.join(created.path, "ignored", "cache.txt"), "rebuildable\n");
    const commands = vi.spyOn(commandSpawner, "spawnCommandWithInvocation");
    try {
      await service.remove({ id: created.id, reason: "test" });
      const broad = commands.mock.calls
        .map(([argv]) => argv)
        .filter((argv) => argv[0] === "git" && !argv.includes("--"));
      expect(
        broad.filter((argv) => argv.includes("ls-files") && !argv.includes("--others")).length,
      ).toBeLessThanOrEqual(1);
      expect(
        broad.filter(
          (argv) =>
            argv.includes("ls-files") &&
            argv.includes("--ignored") &&
            argv.includes("--exclude-standard"),
        ).length,
      ).toBeLessThanOrEqual(1);
      expect(
        broad.filter((argv) => argv.includes("ls-tree") && argv.includes("-r")).length,
      ).toBeLessThanOrEqual(2);
    } finally {
      commands.mockRestore();
    }
    const restored = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "edited tracked content\n",
    );
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "new content\n",
    );
    expect(await fs.readFile(path.join(restored.path, "settings.local"), "utf8")).toBe(
      "synthetic local\n",
    );
    await expect(fs.stat(path.join(restored.path, "ignored", "cache.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves the checkout when HEAD changes during snapshot preparation", async () => {
    const created = await service.create({ repoRoot: repo, name: "head-change", baseRef: "HEAD" });
    const runCommand = commandRunner.runCommandBuffersWithTimeout;
    let changed = false;
    const commands = vi
      .spyOn(commandRunner, "runCommandBuffersWithTimeout")
      .mockImplementation(async (...args) => {
        if (args[0][0] === "git" && args[0].includes("read-tree") && !changed) {
          changed = true;
          await fs.writeFile(path.join(created.path, "later.txt"), "later commit\n");
          await git(created.path, "add", "later.txt");
          await git(created.path, "commit", "-m", "advance HEAD during preparation");
        }
        return await runCommand(...args);
      });
    try {
      await expect(service.remove({ id: created.id, reason: "test" })).rejects.toThrow(
        "HEAD changed",
      );
      expect(changed).toBe(true);
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
      expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
      expect(await fs.readFile(path.join(created.path, "later.txt"), "utf8")).toBe(
        "later commit\n",
      );
    } finally {
      commands.mockRestore();
    }
  });

  it("preserves recovery chunks when snapshot-error cleanup loses allocation ownership", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "lost-snapshot",
      baseRef: "HEAD",
    });
    await fs.writeFile(path.join(created.path, "README.md"), "uncommitted checkout\n");
    const chunk = { worktreeId: created.id, path: "saved.local", chunkIndex: 0 };
    const bytes = new TextEncoder().encode("successor recovery bytes");
    await insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
    const createWriter = provisionedSnapshots.createProvisionedSnapshotWriter;
    let ownershipLost = false;
    const writers = vi
      .spyOn(provisionedSnapshots, "createProvisionedSnapshotWriter")
      .mockImplementation((...args) => {
        const write = createWriter(...args);
        return async (...effectArgs) => {
          if (!ownershipLost && effectArgs[0].type === "worktree.snapshot-provisioned-reset") {
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                const changed = executeSqliteQuerySync(
                  db,
                  getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
                    .updateTable("state_leases")
                    .set({ owner: "successor" })
                    .where("scope", "=", "core:managed-worktrees:create")
                    .where("lease_key", "=", "capacity"),
                );
                expect(changed.numAffectedRows).toBe(1n);
              },
              { env },
            );
            ownershipLost = true;
          }
          return await write(...effectArgs);
        };
      });
    try {
      await expect(service.remove({ id: created.id, reason: "test" })).rejects.toThrow(/was lost/);
      expect(ownershipLost).toBe(true);
      expect(await getRegistryWorktreeProvisionedChunk(env, chunk)).toEqual(bytes);
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
        "uncommitted checkout\n",
      );
    } finally {
      writers.mockRestore();
    }
  });

  it("skips inventories for deleted provisioned contents and restores their absence", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\nignored/\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "synthetic provisioned bytes\n");
    const created = await service.create({ repoRoot: repo, name: "absent", baseRef: "HEAD" });
    const expected = [{ path: ".env.local", mode: null, chunks: 0 }];
    await fs.rm(path.join(created.path, ".env.local"));
    await fs.writeFile(path.join(created.path, "README.md"), "preserved edit\n");
    const oldChunk = { worktreeId: created.id, path: "old.local", chunkIndex: 0 };
    const oldBytes = new TextEncoder().encode("old");
    await insertRegistryWorktreeProvisionedChunk(env, { ...oldChunk, data: oldBytes });
    const guard = vi.fn();
    const commands = vi.spyOn(commandSpawner, "spawnCommandWithInvocation");
    try {
      await expect(
        service.remove({
          id: created.id,
          reason: "test",
          commitGuard: () => {
            throw new Error("authority changed");
          },
        }),
      ).rejects.toThrow("authority changed");
      expect(await getRegistryWorktreeProvisionedChunk(env, oldChunk)).toEqual(oldBytes);
      expect(
        await service.remove({ id: created.id, reason: "test", commitGuard: guard }),
      ).toMatchObject({ removed: true });
      expect(await getRegistryWorktreeProvisionedState(env, created.id)).toEqual(expected);
      expect(guard).toHaveBeenCalled();
      expect(await getRegistryWorktreeProvisionedChunk(env, oldChunk)).toBeUndefined();
      expect(
        commands.mock.calls.some(
          ([argv]) =>
            argv.includes("--literal-pathspecs") &&
            argv.includes(".env.local") &&
            (argv.includes("ls-files") || argv.includes("ls-tree")),
        ),
      ).toBe(false);
    } finally {
      commands.mockRestore();
    }
    expect(await getRegistryWorktreeProvisionedState(env, created.id)).toEqual(expected);
    const restored = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "preserved edit\n",
    );
    await expect(fs.stat(path.join(restored.path, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cancels and joins a parent provisioned-membership child before removal settles", async ({
    signal,
  }) => {
    await fs.writeFile(path.join(repo, ".gitignore"), "settings.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "settings.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure provisioned cancellation");
    await fs.writeFile(path.join(repo, "settings.local"), "synthetic provisioned bytes\n");
    const created = await service.create({ repoRoot: repo, name: "cancelled", baseRef: "HEAD" });
    const marker = path.join(root, "membership-child.pid");
    const runCommand = commandRunner.runCommandWithTimeout;
    let membershipStarted = false;
    const commands = vi
      .spyOn(commandRunner, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        if (argv.includes("--literal-pathspecs") && argv.includes("--ignored")) {
          membershipStarted = true;
          // Use a real held child to exercise cancellation at the process boundary.
          return await runCommand(
            [
              process.execPath,
              "--input-type=module",
              "--eval",
              `import { writeFileSync } from 'node:fs';
              ${fixtureReceiptClientSource(receipts.endpoint)}
              writeFileSync(process.argv[1], String(process.pid));
              sendReceipt(process.argv[1], 'ready');
              setInterval(() => {}, 1000);`,
              marker,
            ],
            options,
          );
        }
        return await runCommand(argv, options);
      });
    const abort = new AbortController();
    const pending = service.remove({ id: created.id, reason: "test", signal: abort.signal }).then(
      () => false,
      () => true,
    );
    let pid: number | undefined;
    try {
      await withinTest(
        Promise.race([
          receipts.waitFor(marker, "ready"),
          pending.then(() => {
            // The fixture writes its PID before it can send a receipt or exit.
            const value = existsSync(marker)
              ? Number.parseInt(readFileSync(marker, "utf8"), 10)
              : Number.NaN;
            if (!Number.isInteger(value) || value <= 0) {
              throw new Error(`Timed out waiting for pid file: ${marker}`);
            }
          }),
        ]),
        signal,
      );
      pid = Number.parseInt(await fs.readFile(marker, "utf8"), 10);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(membershipStarted).toBe(true);
      expect(isPidAlive(pid!)).toBe(true);
      abort.abort(new Error("fixture membership cancelled"));
      // Removal awaits the command runner, which joins its child and process cleanup.
      expect(await withinTest(pending, signal)).toBe(true);
      expect(isPidAlive(pid!)).toBe(false);
      expect(await fs.readFile(path.join(created.path, "settings.local"), "utf8")).toBe(
        "synthetic provisioned bytes\n",
      );
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
      expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
    } finally {
      abort.abort();
      killPidIfAlive(pid);
      await pending;
      commands.mockRestore();
    }
    expect((await service.remove({ id: created.id, reason: "retry" })).removed).toBe(true);
  });

  it("snapshots large provisioned files without buffering them in the service", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "large.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "large.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    const source = Buffer.alloc(2 * 1024 * 1024, 0x61);
    await fs.writeFile(path.join(repo, "large.local"), source);
    await addRemote(root, repo);

    const created = await service.create({ repoRoot: repo, name: "large-local", baseRef: "HEAD" });
    await service.acquire(created.id);
    const copyPath = path.join(created.path, "large.local");
    const copy = Buffer.from(source);
    copy[copy.length - 1] = 0x62;
    await fs.writeFile(copyPath, copy);

    expect(await service.removeIfLossless(created.id)).toBe(true);
    await fs.writeFile(path.join(repo, "large.local"), Buffer.from("new source"));
    const restored = await service.restore({ id: created.id });
    deepStrictEqual(await fs.readFile(path.join(restored.path, "large.local")), copy);
  });

  it("fails closed for pre-ledger worktrees whose ignored state is unknown", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore local environment");
    await addRemote(root, repo);
    const legacyPath = path.join(root, "legacy-worktree");
    await git(repo, "worktree", "add", "-b", "openclaw/legacy", legacyPath, "HEAD");
    insertRegistryWorktree(env, {
      id: "legacy",
      name: "legacy",
      repoFingerprint: "legacy-fingerprint",
      repoRoot: repo,
      path: legacyPath,
      branch: "openclaw/legacy",
      baseRef: "HEAD",
      ownerKind: "session",
      createdAt: now,
      lastActiveAt: now,
    });
    await fs.writeFile(path.join(legacyPath, ".env.local"), "unknown-user-state\n");
    expect(await git(legacyPath, "status", "--porcelain")).toBe("");

    expect(await service.removeIfLossless("legacy")).toBe(false);
    await expect(service.remove({ id: "legacy", reason: "manual" })).rejects.toThrow(
      "provisioned path ledger is unavailable",
    );
    expect(await fs.readFile(path.join(legacyPath, ".env.local"), "utf8")).toBe(
      "unknown-user-state\n",
    );
  });

  it("fails closed when a provisioned path becomes tracked or unignored", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "value=source\n");

    const tracked = await service.create({
      repoRoot: repo,
      name: "tracked-provisioned",
      baseRef: "HEAD",
    });
    await git(tracked.path, "add", "-f", ".env.local");
    await git(tracked.path, "commit", "-m", "track provisioned file");
    await expect(service.remove({ id: tracked.id, reason: "manual" })).rejects.toThrow(
      "provisioned path is now tracked",
    );
    await git(tracked.path, "rm", "--cached", ".env.local");
    await expect(service.remove({ id: tracked.id, reason: "manual" })).rejects.toThrow(
      "provisioned path is tracked at HEAD",
    );

    const unignored = await service.create({
      repoRoot: repo,
      name: "unignored-provisioned",
      baseRef: "HEAD",
    });
    await fs.writeFile(path.join(unignored.path, ".gitignore"), "");
    await expect(service.remove({ id: unignored.id, reason: "manual" })).rejects.toThrow(
      "provisioned path is no longer ignored",
    );
    expect(await fs.readFile(path.join(unignored.path, ".env.local"), "utf8")).toBe(
      "value=source\n",
    );
  });

  it.skipIf(process.platform === "win32")(
    "round trips literal pathspec characters and POSIX backslashes",
    async () => {
      const wildcardName = "literal*.local";
      const backslashName = "foo\\bar.local";
      await fs.writeFile(path.join(repo, "literal-one.local"), "tracked\n");
      await fs.writeFile(path.join(repo, ".gitignore"), "literal*.local\nfoo\\\\bar.local\n");
      await fs.writeFile(path.join(repo, ".worktreeinclude"), "literal*.local\nfoo\\\\bar.local\n");
      await git(repo, "add", ".gitignore", ".worktreeinclude");
      await git(repo, "add", "-f", "literal-one.local");
      await git(repo, "commit", "-m", "configure literal worktree provisioning");
      await fs.writeFile(path.join(repo, wildcardName), "wildcard source\n");
      await fs.writeFile(path.join(repo, backslashName), "backslash source\n");

      const created = await service.create({
        repoRoot: repo,
        name: "literal-paths",
        baseRef: "HEAD",
      });
      await fs.writeFile(path.join(created.path, wildcardName), "wildcard local\n");
      await fs.writeFile(path.join(created.path, backslashName), "backslash local\n");
      await service.remove({ id: created.id, reason: "test" });
      const restored = await service.restore({ id: created.id });

      expect(await fs.readFile(path.join(restored.path, wildcardName), "utf8")).toBe(
        "wildcard local\n",
      );
      expect(await fs.readFile(path.join(restored.path, backslashName), "utf8")).toBe(
        "backslash local\n",
      );
    },
  );

  it("snapshots deleted skip-worktree files still included by sparse rules", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "stale-sparse-bit",
      baseRef: "HEAD",
    });
    await git(created.path, "sparse-checkout", "set", "--no-cone", "/*");
    await git(created.path, "update-index", "--skip-worktree", "README.md");
    await fs.rm(path.join(created.path, "README.md"));

    await service.remove({ id: created.id, reason: "test" });
    const restored = await service.restore({ id: created.id });

    await expect(fs.stat(path.join(restored.path, "README.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform !== "linux")(
    "snapshots non-UTF-8 Git paths byte-for-byte",
    async () => {
      const rawName = Buffer.from([0x72, 0x61, 0x77, 0xff]);
      const sourcePath = Buffer.concat([Buffer.from(repo), Buffer.from(path.sep), rawName]);
      await fs.writeFile(sourcePath, "source\n");
      await git(repo, "add", "-A");
      await git(repo, "commit", "-m", "add raw path");

      const created = await service.create({ repoRoot: repo, name: "raw-path", baseRef: "HEAD" });
      const worktreePath = Buffer.concat([
        Buffer.from(created.path),
        Buffer.from(path.sep),
        rawName,
      ]);
      await fs.writeFile(worktreePath, "local bytes\n");
      await service.remove({ id: created.id, reason: "test" });
      const restored = await service.restore({ id: created.id });
      const restoredPath = Buffer.concat([
        Buffer.from(restored.path),
        Buffer.from(path.sep),
        rawName,
      ]);

      expect(await fs.readFile(restoredPath, "utf8")).toBe("local bytes\n");
    },
  );

  it.each([
    {
      replacement: "file-to-directory",
      originalPath: "entry",
      replacementPath: "entry/child.txt",
      snapshotPaths: ["README.md", "entry/child.txt"],
      directory: true,
      staged: false,
    },
    {
      replacement: "staged-file-to-directory",
      originalPath: "entry",
      replacementPath: "entry/child.txt",
      snapshotPaths: ["README.md", "entry/child.txt"],
      directory: true,
      staged: true,
    },
    {
      replacement: "staged-directory-to-file",
      originalPath: "entry/child.txt",
      replacementPath: "entry",
      snapshotPaths: ["README.md", "entry"],
      directory: false,
      staged: true,
    },
  ])("round trips a tracked $replacement replacement", async (row) => {
    const originalPath = path.join(repo, row.originalPath);
    await fs.mkdir(path.dirname(originalPath), { recursive: true });
    await fs.writeFile(originalPath, "original\n");
    await git(repo, "add", row.originalPath);
    await git(repo, "commit", "-m", "add original entry");
    const created = await service.create({
      repoRoot: repo,
      name: row.replacement,
      baseRef: "HEAD",
    });
    const originalHead = await git(created.path, "rev-parse", "HEAD");
    await fs.rm(path.join(created.path, "entry"), { recursive: true });
    const replacementPath = path.join(created.path, row.replacementPath);
    await fs.mkdir(path.dirname(replacementPath), { recursive: true });
    await fs.writeFile(replacementPath, "local replacement\n");
    if (row.staged) {
      await git(created.path, "add", "-A");
    }

    const removed = await service.remove({ id: created.id, reason: "test" });
    expect(
      (await git(repo, "ls-tree", "-r", "--name-only", removed.snapshotRef!)).split("\n"),
    ).toEqual(row.snapshotPaths);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await service.restore({ id: created.id });

    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect((await fs.stat(path.join(restored.path, "entry"))).isDirectory()).toBe(row.directory);
    expect(await fs.readFile(path.join(restored.path, row.replacementPath), "utf8")).toBe(
      "local replacement\n",
    );
    expect(await git(restored.path, "diff", "--cached", "--name-only")).toBe("");
  });

  it.each(["tracked file", "untracked child"] as const)(
    "snapshots a reappearing %s before the index update",
    async (kind) => {
      const child = kind === "untracked child";
      if (child) {
        await fs.writeFile(path.join(repo, "entry"), "original file\n");
        await git(repo, "add", "entry");
        await git(repo, "commit", "-m", "add tracked parent");
      }
      const created = await service.create({
        repoRoot: repo,
        name: child ? "reappearing-child" : "reappearing-file",
        baseRef: "HEAD",
      });
      const originalHead = await git(created.path, "rev-parse", "HEAD");
      const relativePath = child ? "entry/child.txt" : "README.md";
      const localPath = path.join(created.path, relativePath);
      const contents = child ? "reappeared child\n" : "reappeared contents\n";
      if (child) {
        const parentPath = path.dirname(localPath);
        await fs.rm(parentPath);
        await fs.mkdir(parentPath);
        await fs.writeFile(localPath, "discovered child\n");
      } else {
        await fs.rm(localPath);
      }
      const runCommand = commandRunner.runCommandBuffersWithTimeout;
      let disappeared = false;
      let reappeared = false;
      const commandSpy = vi.spyOn(commandRunner, "runCommandBuffersWithTimeout");
      commandSpy.mockImplementation(async (...args) => {
        const argv = args[0];
        if (
          child &&
          argv[0] === "git" &&
          argv.includes("read-tree") &&
          argv.at(-1) === originalHead
        ) {
          const result = await runCommand(...args);
          expect(result.code).toBe(0);
          expect(disappeared).toBe(false);
          await fs.rm(localPath);
          disappeared = true;
          return result;
        }
        if (
          argv[0] === "git" &&
          argv.includes("update-index") &&
          argv.includes("--add") &&
          argv.includes("--remove") &&
          argv.includes("--stdin")
        ) {
          if (child) {
            expect(disappeared).toBe(true);
          }
          expect(reappeared).toBe(false);
          await expect(fs.stat(localPath)).rejects.toMatchObject({ code: "ENOENT" });
          await fs.writeFile(localPath, contents);
          reappeared = true;
        }
        return await runCommand(...args);
      });

      try {
        const removed = await service.remove({ id: created.id, reason: "test" });
        expect(reappeared).toBe(true);
        if (child) {
          expect(
            (await git(repo, "ls-tree", "-r", "--name-only", removed.snapshotRef!)).split("\n"),
          ).toEqual(["README.md", "entry/child.txt"]);
        } else {
          expect(await git(repo, "show", `${removed.snapshotRef}:README.md`)).toBe(contents.trim());
          await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const restored = await service.restore({ id: created.id });

        expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
        if (child) {
          expect((await fs.stat(path.join(restored.path, "entry"))).isDirectory()).toBe(true);
        }
        expect(await fs.readFile(path.join(restored.path, relativePath), "utf8")).toBe(contents);
        expect(await git(restored.path, "diff", "--cached", "--name-only")).toBe("");
      } finally {
        commandSpy.mockRestore();
      }
    },
  );
});

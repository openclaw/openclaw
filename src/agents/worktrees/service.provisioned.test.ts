import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { probeTreeClone, readCloneFileMetadata } from "@openclaw/fs-safe/copy";
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
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as commandRunner from "../../process/exec-runner.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
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
import { materializeManagedWorktreeFixture } from "./service.test-support.js";
import { captureManagedWorktreeSnapshot } from "./snapshot-host.js";

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
    vi.restoreAllMocks();
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

  it("preserves the checkout when HEAD changes during snapshot preparation", async () => {
    const created = await service.create({ repoRoot: repo, name: "head-change", baseRef: "HEAD" });
    const runCommand = gitExec.executeGitCommandBytes;
    let changed = false;
    const commands = vi
      .spyOn(gitExec, "executeGitCommandBytes")
      .mockImplementation(async (cwd, args, options) => {
        if (args.includes("read-tree") && !changed) {
          changed = true;
          await fs.writeFile(path.join(created.path, "later.txt"), "later commit\n");
          await git(created.path, "add", "later.txt");
          await git(created.path, "commit", "-m", "advance HEAD during preparation");
        }
        return await runCommand(cwd, args, options);
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
                    .where("scope", "=", "core:managed-worktrees:mutation")
                    .where("lease_key", "=", created.id),
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

  it("retains provisioned bytes when a Git-worker snapshot loses native settlement", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "settings.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "settings.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure retained snapshot");
    const bytes = new TextEncoder().encode("synthetic recovery bytes\n");
    await fs.writeFile(path.join(repo, "settings.local"), bytes);
    const record = await service.create({ repoRoot: repo, name: "uncertain", baseRef: "HEAD" });
    const uncertain = new SqliteWorkerError("Synthetic lost native settlement", "outcome-unknown");
    const run = stateWorker.runOpenClawStateWorkerOperation;
    let writes = 0;
    const settlement = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) => {
        let loseSettlement = false;
        return run(
          context,
          (scope) =>
            operation({
              execute: (command, executeOptions) => {
                if (command.type === "worktrees.writeProvisionedSnapshot") {
                  writes += 1;
                  loseSettlement = writes === 2;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          {
            ...options,
            createAdmission: (retained) => {
              if (!options?.createAdmission) {
                throw new Error("Expected snapshot transaction admission");
              }
              return options.createAdmission({
                settled: retained.settled.then((outcome) =>
                  loseSettlement ? { kind: "unknown", error: uncertain } : outcome,
                ),
              });
            },
          },
        );
      });
    try {
      await expect(
        withWorktreeGitConfig(record.path, false, {}, (gitPolicy) =>
          captureManagedWorktreeSnapshot({
            record,
            env,
            reason: "unknown-settlement",
            provisionedPaths: ["settings.local"],
            git: gitPolicy,
            requireDiskSpace: async () => {},
          }),
        ),
      ).rejects.toMatchObject({ code: "outcome-unknown" });
    } finally {
      settlement.mockRestore();
    }
    expect(writes).toBe(2);
    expect(
      await getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: record.id,
        path: "settings.local",
        chunkIndex: 0,
      }),
    ).toEqual(bytes);
    expect(await fs.readFile(path.join(record.path, "settings.local"))).toEqual(Buffer.from(bytes));
    expect(getRegistryWorktree(env, record.id)?.snapshotRef).toBeUndefined();
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

  it("fails closed for pre-ledger worktrees whose ignored state is unknown", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore local environment");
    await addRemote(root, repo);
    const legacyPath = path.join(root, "legacy-worktree");
    await git(repo, "worktree", "add", "-b", "openclaw/legacy", legacyPath, "HEAD");
    await insertRegistryWorktree(env, {
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

  it.each([
    {
      replacement: "staged-file-to-directory",
      originalPath: "entry",
      replacementPath: "entry/child.txt",
      snapshotPaths: ["README.md", "entry/child.txt"],
      directory: true,
    },
    {
      replacement: "staged-directory-to-file",
      originalPath: "entry/child.txt",
      replacementPath: "entry",
      snapshotPaths: ["README.md", "entry"],
      directory: false,
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
    await git(created.path, "add", "-A");

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
      const runCommand = gitExec.executeGitCommandBytes;
      let disappeared = false;
      let reappeared = false;
      const commandSpy = vi.spyOn(gitExec, "executeGitCommandBytes");
      commandSpy.mockImplementation(async (cwd, args, options) => {
        if (child && args.includes("read-tree") && args.at(-1) === originalHead) {
          const result = await runCommand(cwd, args, options);
          expect(result.code).toBe(0);
          expect(disappeared).toBe(false);
          await fs.rm(localPath);
          disappeared = true;
          return result;
        }
        if (
          args.includes("update-index") &&
          args.includes("--add") &&
          args.includes("--remove") &&
          args.includes("--stdin")
        ) {
          if (child) {
            expect(disappeared).toBe(true);
          }
          expect(reappeared).toBe(false);
          await expect(fs.stat(localPath)).rejects.toMatchObject({ code: "ENOENT" });
          await fs.writeFile(localPath, contents);
          reappeared = true;
        }
        return await runCommand(cwd, args, options);
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

  it("captures same-stat racy edits without modifying the checkout index", async () => {
    const created = await materializeManagedWorktreeFixture({
      env,
      name: "racy-snapshot",
      now,
      repoRoot: repo,
      stateDir: env.OPENCLAW_STATE_DIR!,
    });
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
    const inspectCopy = async (copiedIndex: string) => {
      const [sourceStat, copiedStat, copiedBytes] = await Promise.all([
        fs.stat(index, { bigint: true }),
        fs.stat(copiedIndex, { bigint: true }),
        fs.readFile(copiedIndex),
      ]);
      const cloneMetadata =
        process.platform === "darwin" && probeTreeClone(path.dirname(copiedIndex)) === "apfs"
          ? await readCloneFileMetadata([index, copiedIndex])
          : undefined;
      return { sourceStat, copiedStat, copiedBytes, cloneMetadata };
    };
    const copies: Awaited<ReturnType<typeof inspectCopy>>[] = [];
    const inspectionErrors: unknown[] = [];
    const runBytes = commandRunner.runCommandBuffersWithTimeout;
    vi.spyOn(commandRunner, "runCommandBuffersWithTimeout").mockImplementation(async (...args) => {
      const argv = args[0];
      const options = args[1];
      const copiedIndex = typeof options === "object" ? options.env?.GIT_INDEX_FILE : undefined;
      if (copiedIndex && argv.includes("read-tree") && argv.includes("--reset")) {
        // Retain observations before Git rewrites the copy; assert outside product recovery.
        try {
          copies.push(await inspectCopy(copiedIndex));
        } catch (error) {
          inspectionErrors.push(error);
        }
      }
      return await runBytes(...args);
    });
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const argv = args[0];
      if (argv.includes("git") && argv.includes("worktree") && argv.includes("remove")) {
        expect(await fs.readFile(index)).toEqual(bytes);
        checkedIndex = true;
      }
      return await run(...args);
    });
    const removed = await service.remove({ id: created.id, reason: "test" });
    expect(inspectionErrors).toEqual([]);
    expect(copies).toHaveLength(1);
    for (const { sourceStat, copiedStat, copiedBytes, cloneMetadata } of copies) {
      expect(copiedBytes).toEqual(bytes);
      expect([copiedStat.dev, copiedStat.ino]).not.toEqual([sourceStat.dev, sourceStat.ino]);
      expect(copiedStat.mtimeNs).toBe(1_600_000_000_000_000_000n);
      if (process.platform !== "win32") {
        expect(copiedStat.mode & 0o777n).toBe(sourceStat.mode & 0o777n);
      }
      if (cloneMetadata) {
        const [sourceMetadata, copiedMetadata] = cloneMetadata;
        expect(sourceMetadata?.cloneId).toBeTruthy();
        expect(copiedMetadata?.cloneId).toBe(sourceMetadata?.cloneId);
      }
    }
    expect(checkedIndex).toBe(true);
    expect(await git(repo, "show", `${removed.snapshotRef}:README.md`)).toBe("edit");
  });

  it.each(["missing", "sparse"])(
    "snapshots working contents with a %s source index",
    async (kind) => {
      for (const directory of ["included", "excluded"]) {
        await fs.mkdir(path.join(repo, directory));
        await fs.writeFile(path.join(repo, directory, "file.txt"), `${directory} original\n`);
      }
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "add snapshot directories");
      const created = await materializeManagedWorktreeFixture({
        env,
        name: `index-${kind}`,
        now,
        repoRoot: repo,
        stateDir: env.OPENCLAW_STATE_DIR!,
      });
      const originalHead = await git(created.path, "rev-parse", "HEAD");
      if (kind === "sparse") {
        await git(created.path, "sparse-checkout", "set", "--cone", "--sparse-index", "included");
      }
      await fs.writeFile(path.join(created.path, "README.md"), "staged content\n");
      await git(created.path, "add", "README.md");
      if (kind === "missing") {
        const index = await git(created.path, "rev-parse", "--git-path", "index");
        await fs.rm(path.resolve(created.path, index));
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

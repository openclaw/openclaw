import { execFile } from "node:child_process";
import fsSync, { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as commandRunner from "../../process/exec-runner.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { InvalidWorktreeBaseRefError } from "./base-ref.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";
import * as worktreeGit from "./git.js";
import * as worktreeRegistry from "./registry.js";
import {
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  updateRegistryWorktree,
  WorktreeRemovalContentionError,
} from "./registry.js";
import { getRegistryWorktree, listRegistryWorktrees } from "./registry.test-support.js";
import { acquireWorktreeRunLease, claimWorktreeRemoval } from "./run-lease.js";
import { testing as runLeaseTesting } from "./run-lease.test-support.js";
import { expectMissing, git, readText, writeFile } from "./service-files.test-support.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);

function isWorktreeAdd(argv: readonly string[]): boolean {
  if (argv[0] !== "git") {
    return false;
  }
  let command = 1;
  while (argv[command] === "-c" || argv[command] === "-C") {
    command += 2;
  }
  return argv[command] === "worktree" && argv[command + 1] === "add";
}

function expectCheckoutTimeouts(
  commandSpy: MockInstance<typeof commandRunner.runCommandWithTimeout>,
  checkoutBases: [string, string],
  networkTimeouts: number[] = [],
) {
  const gitCommands = commandSpy.mock.calls
    .filter(([argv]) => argv[0] === "git")
    .map(([argv, options]) => ({
      checkout: isWorktreeAdd(argv) || (argv.includes("read-tree") && argv.includes("-u")),
      base: argv.at(-1),
      timeoutMs: typeof options === "number" ? options : options.timeoutMs,
      noOutputTimeoutMs: typeof options === "number" ? undefined : options.noOutputTimeoutMs,
    }));
  expect(gitCommands.filter((command) => command.checkout)).toEqual([
    { checkout: true, base: checkoutBases[0], timeoutMs: 300_000, noOutputTimeoutMs: undefined },
    { checkout: true, base: checkoutBases[1], timeoutMs: undefined, noOutputTimeoutMs: 300_000 },
  ]);
  expect(
    new Set(gitCommands.filter((command) => !command.checkout).map((command) => command.timeoutMs)),
  ).toEqual(new Set([120_000, ...networkTimeouts]));
}

async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  const command = execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  command.child.stdin?.end(input);
  return (await command).stdout.trim();
}

async function addRemote(root: string, repo: string): Promise<string> {
  await git(path.join(root, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/main");
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "-a");
  return path.join(root, "remote.git");
}

describe("ManagedWorktreeService", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      runLeaseTesting.resetForTest();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      clearRuntimeConfigSnapshot();
      cleanup();
    }),
  );
  let stateDir: string;
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  function create(
    name: string,
    options: Omit<Parameters<ManagedWorktreeService["create"]>[0], "repoRoot" | "name"> = {},
  ) {
    return service.create({ repoRoot: repo, name, baseRef: "HEAD", ...options });
  }

  async function commitFiles(files: Record<string, string>, message = "fixture") {
    for (const [file, contents] of Object.entries(files)) {
      await writeFile(repo, file, contents);
    }
    await git(repo, "add", ...Object.keys(files));
    await git(repo, "commit", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  }

  async function configureIncludes(ignored: string, included = ignored) {
    await writeFile(repo, ".gitignore", ignored);
    await writeFile(repo, ".worktreeinclude", included);
  }

  async function expectNoCheckout(name: string) {
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(name);
    expect(await git(repo, "branch", "--list", `openclaw/${name}`)).toBe("");
  }

  function expectOutcome(id: string, outcome: string, removedAt?: number) {
    expect(getRegistryWorktree(env, id)).toMatchObject({
      removedAt,
      runEndCleanup: { outcome, at: now },
    });
  }

  async function materializeDownstreamFixture(
    name: string,
    params: {
      ownerKind?: "manual" | "session" | "workboard";
      ownerId?: string;
      provisionedPaths?: readonly string[];
      repoRoot?: string;
    } = {},
  ) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now,
      repoRoot: params.repoRoot ?? repo,
      stateDir,
      ...params,
    });
  }

  beforeEach(async () => {
    root = await fs.realpath(tempDirs.make("openclaw-worktrees-"));
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  it("does not remove a worktree owned by another caller", async () => {
    const created = await create("session-owned", { ownerKind: "session", ownerId: "session-1" });

    await expect(
      service.removeIfLosslessByPath(created.path, {
        ownerKind: "workboard",
        ownerId: "card-1",
      }),
    ).resolves.toBe(false);
    await expect(fs.stat(created.path)).resolves.toBeDefined();
  });

  it("creates a worktree from a remote-only branch ref returned by the picker", async () => {
    await addRemote(root, repo);
    await git(repo, "checkout", "-b", "remote-only");
    const remoteCommit = await commitFiles({ "remote-only.txt": "remote\n" });
    await git(repo, "push", "origin", "remote-only");
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "remote-only");

    const listed = await service.listRepositoryBranches(repo);
    const remoteRef = listed.branches.find((branch) => branch.kind === "remote")?.name;
    expect(remoteRef).toBe("origin/remote-only");
    const created = await create("from-remote", { baseRef: remoteRef });
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteCommit);
    expect(
      await git(created.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    ).toBe("origin/remote-only");
  });

  it.each([
    ["dashed ref", "--force", "tip"],
    ["dashed revision expression", "--force~1", "parent"],
    ["previous-checkout shorthand", "-", "tip"],
  ] as const)("creates from a %s", async (_kind, baseRef, target) => {
    await git(repo, "checkout", "-b", "previous");
    const secondCommit = await commitFiles({ "history.txt": "second\n" });
    const thirdCommit = await commitFiles({ "history.txt": "second\nthird\n" });
    await git(repo, "update-ref", "refs/tags/--force", thirdCommit);
    await git(repo, "checkout", "main");
    const created = await create("normalized-ref", { baseRef });
    expect(created.baseRef).toBe(baseRef);
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(
      target === "parent" ? secondCommit : thirdCommit,
    );
  });

  it.each(["--ambiguous", "--orphan"])(
    "rejects invalid dashed base %s without state",
    async (baseRef) => {
      if (baseRef === "--ambiguous") {
        const initialCommit = await git(repo, "rev-parse", "HEAD");
        const tagCommit = await commitFiles({ "tag.txt": "tag\n" });
        await git(repo, "reset", "--hard", initialCommit);
        const branchCommit = await commitFiles({ "branch.txt": "branch\n" });
        await git(repo, "update-ref", `refs/tags/${baseRef}`, tagCommit);
        await git(repo, "update-ref", `refs/heads/${baseRef}`, branchCommit);
        await git(repo, "config", "core.warnAmbiguousRefs", "false");
      }
      const name = baseRef.slice(2);
      const before = await git(repo, "worktree", "list", "--porcelain");
      await expect(create(name, { baseRef })).rejects.toThrow(InvalidWorktreeBaseRefError);
      expect(await git(repo, "worktree", "list", "--porcelain")).toBe(before);
      expect(await git(repo, "branch", "--list", `openclaw/${name}`)).toBe("");
      expect(await service.list()).toEqual([]);
      await expect(fs.readdir(path.join(env.OPENCLAW_STATE_DIR!, "worktrees"))).resolves.toEqual(
        [],
      );
    },
  );

  it("rejects name reuse across owners instead of adopting a foreign worktree", async () => {
    await create("shared-name", { ownerKind: "session", ownerId: "agent:main:dashboard:one" });
    await expect(
      create("shared-name", { ownerKind: "session", ownerId: "agent:main:dashboard:two" }),
    ).rejects.toThrow(/already in use by session/);
    await expect(create("shared-name")).rejects.toThrow(/already in use by session/);
    const reused = await create("shared-name", {
      ownerKind: "session",
      ownerId: "agent:main:dashboard:one",
    });
    expect(reused.ownerId).toBe("agent:main:dashboard:one");
  });

  it("refuses an unavailable remote default instead of silently using local HEAD", async () => {
    await git(repo, "remote", "set-url", "origin", path.join(root, "missing.git"));
    await git(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD").catch(() => undefined);
    await expect(service.create({ repoRoot: repo, name: "offline" })).rejects.toThrow(
      "Remote default branch is unavailable",
    );
    expect(await git(repo, "branch", "--list", "openclaw/offline")).toBe("");
  });

  it.each(["aborted", "closed"] as const)(
    "handles stale remote checkout with %s admission",
    async (admission) => {
      await addRemote(root, repo);
      const blob = await git(repo, "rev-parse", "HEAD:README.md");
      const tooLongForCheckout = "x".repeat(300);
      const tree = await gitWithInput(
        repo,
        ["mktree"],
        `100644 blob ${blob}\t${tooLongForCheckout}\n`,
      );
      const remoteCommit = await git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "bad remote");
      await git(repo, "push", "--force", "origin", `${remoteCommit}:refs/heads/main`);
      const runCommand = commandRunner.runCommandWithTimeout;
      const commandSpy = vi.spyOn(commandRunner, "runCommandWithTimeout");
      const controller = new AbortController();
      const closed = new Error("admission closed");
      let authorityClosed = false;
      let checkoutFailed = false;
      commandSpy.mockImplementation(async (...args) => {
        const result = await runCommand(...args);
        if (args[0][0] === "git" && args[0].includes("read-tree") && result.code !== 0) {
          checkoutFailed = true;
          if (admission === "aborted") {
            controller.abort(closed);
          }
          authorityClosed = admission === "closed";
        }
        return result;
      });
      const creation = service.create({
        repoRoot: repo,
        name: "stale-remote",
        signal: controller.signal,
        commitGuard: () => {
          if (authorityClosed) {
            throw closed;
          }
        },
      });
      await expect(creation).rejects.toMatchObject(
        admission === "aborted" ? { code: "OPENCLAW_STATE_LEASE_ABORTED" } : closed,
      );
      expect(checkoutFailed).toBe(true);
      expectCheckoutTimeouts(
        commandSpy,
        ["refs/remotes/origin/main", remoteCommit],
        [30_000, 60_000],
      );
      await expectNoCheckout("stale-remote");
    },
  );

  it("copies included ignored regular files independently, including large literal-tilde paths and hardlinks, without following symlinks", async () => {
    await configureIncludes("~/\nlinked\nlinked-dir/\n", "~/*.txt\nlinked\nlinked-dir/**\n");
    await fs.mkdir(path.join(repo, "~"));
    const contents = Buffer.alloc(17 * 1024 * 1024, "x");
    await fs.writeFile(path.join(repo, "~", "keep.txt"), contents);
    await fs.chmod(path.join(repo, "~", "keep.txt"), 0o744);
    await fs.link(path.join(repo, "~", "keep.txt"), path.join(repo, "~", "linked.txt"));
    await fs.writeFile(path.join(repo, "~", "skip.bin"), "skip\n");
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "outside\n");
    await fs.symlink(outside, path.join(repo, "linked"));
    const outsideDir = path.join(root, "outside-dir");
    await fs.mkdir(outsideDir);
    await writeFile(outsideDir, "escape.txt", "outside\n");
    await fs.symlink(outsideDir, path.join(repo, "linked-dir"));

    const created = await create("includes");
    const copied = path.join(created.path, "~", "keep.txt");
    expect(Buffer.compare(await fs.readFile(copied), contents)).toBe(0);
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o744);
    expect(await getRegistryWorktreeProvisionedPaths(env, created.id)).toEqual([
      "~/keep.txt",
      "~/linked.txt",
    ]);
    await fs.writeFile(copied, "worktree edit\n");
    expect(Buffer.compare(await fs.readFile(path.join(repo, "~", "keep.txt")), contents)).toBe(0);
    expect(
      Buffer.compare(await fs.readFile(path.join(created.path, "~", "linked.txt")), contents),
    ).toBe(0);
    for (const file of ["~/skip.bin", "linked", "linked-dir/escape.txt"]) {
      await expectMissing(fs.stat(path.join(created.path, file)));
    }
  });

  it("rejects an included file replaced by a symlink after inspection", async () => {
    await configureIncludes("settings.local\n");
    const source = path.join(repo, "settings.local");
    await fs.writeFile(source, "included bytes\n");
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "outside bytes\n");
    const lstat = fs.lstat.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const observed = await lstat(...args);
      if (args[0] === source && !replaced) {
        replaced = true;
        await fs.rename(source, `${source}.original`);
        await fs.symlink(outside, source);
      }
      return observed;
    });

    await expect(create("swapped-source")).rejects.toThrow();

    expect(replaced).toBe(true);
    expect(listRegistryWorktrees(env)).toEqual([]);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(
      "refs/heads/openclaw/swapped-source",
    );
    expect(await fs.readFile(outside, "utf8")).toBe("outside bytes\n");
  });

  it("rematerializes a named workboard snapshot with hidden edits and independent provisioned state", async () => {
    await configureIncludes(
      "ignored.txt\npresent.env\ndeleted.env\n",
      "present.env\ndeleted.env\n",
    );
    for (const file of ["assumed.txt", "skipped.txt", "deleted.txt", "tool.sh"]) {
      await writeFile(repo, file, "original\n");
    }
    await git(repo, "add", ".");
    await git(repo, "update-index", "--chmod=+x", "tool.sh");
    await git(repo, "commit", "-m", "snapshot inputs");
    await git(repo, "config", "core.filemode", "false");
    for (const file of ["present.env", "deleted.env"]) {
      await writeFile(repo, file, "source value\n");
    }
    const owner = { ownerKind: "workboard" as const, ownerId: "card" };
    const created = await create("roundtrip", owner);
    const originalHead = await git(created.path, "rev-parse", "HEAD");
    await git(created.path, "update-index", "--assume-unchanged", "assumed.txt");
    await git(created.path, "update-index", "--skip-worktree", "skipped.txt", "deleted.txt");
    const localFiles = ["README.md", "assumed.txt", "skipped.txt", "untracked.txt", "present.env"];
    for (const file of [...localFiles, "ignored.txt"]) {
      await writeFile(created.path, file, `${file} local\n`);
    }
    await fs.chmod(path.join(created.path, "tool.sh"), 0o644);
    if (process.platform !== "win32") {
      await fs.chmod(path.join(created.path, "present.env"), 0o1644);
    }
    const mode = (await fs.stat(path.join(created.path, "present.env"))).mode & 0o7777;
    for (const file of ["deleted.txt", "deleted.env"]) {
      await fs.rm(path.join(created.path, file));
    }
    expect(await git(created.path, "status", "--porcelain")).not.toMatch(
      /assumed|skipped|deleted|tool/,
    );
    const removed = await service.remove({ id: created.id, reason: "run-end" });
    expect(removed).toMatchObject({ removed: true, snapshotRef: expect.any(String) });
    await expectMissing(fs.stat(created.path));
    expect(await getRegistryWorktreeProvisionedState(env, created.id)).toEqual([
      { path: "deleted.env", mode: null, chunks: 0 },
      { path: "present.env", mode, chunks: 1 },
    ]);
    expect(await git(repo, "ls-tree", "-r", "--name-only", removed.snapshotRef!)).not.toMatch(
      /ignored.txt|present.env|deleted.env/,
    );
    expect(await git(repo, "ls-tree", removed.snapshotRef!, "tool.sh")).toMatch(/^100644 /);
    await writeFile(repo, "present.env", "new source value\n");
    now += IDLE_GC_MS + 1;
    const commandSpy = vi.spyOn(commandRunner, "runCommandWithTimeout");
    const restored = await create("roundtrip", { ...owner, baseRef: created.branch });
    expect(restored).toMatchObject({ id: created.id, removedAt: undefined, lastActiveAt: now });
    expectCheckoutTimeouts(commandSpy, [
      originalHead,
      await git(repo, "rev-parse", removed.snapshotRef!),
    ]);
    expect((await service.gc()).removed).toEqual([]);
    expect(await git(restored.path, "branch", "--show-current")).toBe(created.branch);
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await git(restored.path, "log", "--format=%s", created.branch)).not.toContain(
      "OpenClaw worktree snapshot",
    );
    for (const file of localFiles) {
      expect(await readText(restored.path, file)).toBe(`${file} local\n`);
    }
    expect((await fs.stat(path.join(restored.path, "present.env"))).mode & 0o7777).toBe(mode);
    for (const file of ["ignored.txt", "deleted.txt", "deleted.env"]) {
      await expectMissing(fs.stat(path.join(restored.path, file)));
    }
    expect(await git(restored.path, "diff", "--cached", "--name-only")).toBe("");
    expect(await git(restored.path, "diff", "--name-only")).toBe(
      "README.md\nassumed.txt\ndeleted.txt\nskipped.txt",
    );
    expect((await git(restored.path, "status", "--porcelain")).split("\n").at(-1)).toBe(
      "?? untracked.txt",
    );
  });

  it("rejects a snapshot hidden by the shallow clone boundary", async () => {
    await commitFiles({ "README.md": "second commit\n" });
    const remote = await addRemote(root, repo);
    const clone = path.join(root, "shallow");
    await git(root, "clone", "--depth=1", pathToFileURL(remote).href, clone);
    const created = await materializeDownstreamFixture("shallow-restore", { repoRoot: clone });
    await writeFile(created.path, "README.md", "saved changes\n");
    const removed = await service.remove({ id: created.id, reason: "test" });
    const snapshotRef = removed.snapshotRef!;
    const snapshotCommit = await git(clone, "rev-parse", snapshotRef);
    // A later depth-limited fetch can graft the local snapshot itself. Merely
    // putting its parent on the boundary does not hide the snapshot's parent.
    await git(clone, "fetch", "--depth=1", pathToFileURL(clone).href, snapshotRef);
    await expect(git(clone, "rev-parse", `${snapshotRef}^`)).rejects.toThrow("unknown revision");
    await expect(service.restore({ id: created.id })).rejects.toThrow(
      `Cannot restore snapshot ${snapshotCommit} in ${clone}: shallow clone boundary; run \`git fetch --unshallow\` in ${clone}`,
    );
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBe(snapshotRef);
    await expectMissing(fs.stat(created.path));
  });

  it("refuses to overwrite a branch advanced after removal", async () => {
    const created = await materializeDownstreamFixture("restore-collision");
    await service.remove({ id: created.id, reason: "test" });
    await git(repo, "commit", "--allow-empty", "-m", "new branch state");
    await git(repo, "branch", created.branch, "HEAD");
    const branchTip = await git(repo, "rev-parse", created.branch);

    await expect(service.restore({ id: created.id })).rejects.toThrow("Recorded branch moved");

    expect(await git(repo, "rev-parse", created.branch)).toBe(branchTip);
    await expectMissing(fs.stat(created.path));
  });

  it.skipIf(process.platform === "win32")(
    "retains a provisioned file replaced with a symlink",
    async () => {
      await commitFiles({ ".gitignore": ".env.local\n", ".worktreeinclude": ".env.local\n" });
      const source = path.join(repo, ".env.local");
      await fs.writeFile(source, "source\n");
      await addRemote(root, repo);
      const created = await materializeDownstreamFixture("linked-local", {
        provisionedPaths: [".env.local"],
      });
      await service.acquire(created.id);
      const copy = path.join(created.path, ".env.local");
      await fs.rm(copy);
      await fs.symlink(source, copy);
      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect(await service.removeIfLossless(created.id)).toBe(false);
      expect((await fs.lstat(copy)).isSymbolicLink()).toBe(true);
    },
  );

  describe("run-end cleanup", () => {
    beforeEach(() => {
      setRuntimeConfigSnapshot({});
      service = new ManagedWorktreeService({ env, now: () => now });
    });
    async function materialize(name: string) {
      return materializeDownstreamFixture(name, {
        ownerKind: "workboard",
        ownerId: `card-${name}`,
      });
    }

    it("removes an allocated worktree when its commit guard closes during setup", async () => {
      const setup = path.join(repo, ".openclaw");
      await fs.mkdir(setup);
      const closed = path.join(setup, "authority-closed");
      await fs.writeFile(
        path.join(setup, "worktree-setup.sh"),
        '#!/bin/sh\ntouch "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/authority-closed"\n',
        { mode: 0o755 },
      );
      await expect(
        create("closed-authority", {
          commitGuard: () => {
            if (existsSync(closed)) {
              throw new TypeError("authority closed");
            }
          },
        }),
      ).rejects.toThrow("authority closed");

      expect(existsSync(closed)).toBe(true);

      await expectNoCheckout("closed-authority");
      expect(listRegistryWorktrees(env)).toEqual([]);
    });

    it("preserves removal outcomes against late claims and post-abort writes", async () => {
      const created = await materialize("late-claim");
      await service.acquire(created.id);
      const staleRecord = getRegistryWorktree(env, created.id)!;

      await expect(service.removeIfLossless(created.id)).resolves.toBe(true);

      const contention = await claimWorktreeRemoval(env, {
        worktreeId: staleRecord.id,
        token: "late-remover",
      }).catch((error: unknown) => error);
      expect(contention).toBeInstanceOf(WorktreeRemovalContentionError);
      expect(contention).toMatchObject({ kind: "finalized" });
      expectOutcome(created.id, "removed-lossless", now);

      // A finalized row rejects a stale remover's post-abort outcome.
      await updateRegistryWorktree(
        env,
        created.id,
        { runEndCleanup: { outcome: "retained-dirty", at: now + 1 } },
        { onlyIfLive: true },
      );

      expectOutcome(created.id, "removed-lossless", now);
    });

    it("rejects stale lifecycle writes and records a newer post-restore cleanup outcome", async () => {
      const created = await materialize("restore-generation");
      const staleActiveAt = created.lastActiveAt;
      await service.acquire(created.id);
      await expect(service.removeIfLossless(created.id)).resolves.toBe(true);
      expect(getRegistryWorktree(env, created.id)?.runEndCleanup).toMatchObject({
        outcome: "removed-lossless",
      });

      const restored = await service.restore({ id: created.id });
      expect(restored).toMatchObject({ lastActiveAt: staleActiveAt + 1, runEndCleanup: undefined });
      expect(getRegistryWorktree(env, created.id)?.runEndCleanup).toBeUndefined();

      // A revived row rejects the prior lifecycle's activity stamp.
      await updateRegistryWorktree(
        env,
        created.id,
        { runEndCleanup: { outcome: "retained-dirty", at: now + 1 } },
        { onlyIfLive: true, onlyIfActiveAt: staleActiveAt },
      );

      expect(getRegistryWorktree(env, created.id)?.runEndCleanup).toBeUndefined();
      await writeFile(restored.path, "untracked.txt", "retain me\n");
      await service.acquire(created.id);
      await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

      expectOutcome(created.id, "retained-dirty");
      expect(await readText(restored.path, "untracked.txt")).toBe("retain me\n");
    });

    it("retains an ignored nested linked repository at run end", async () => {
      await commitFiles({ ".gitignore": "nested/\n" });
      await git(repo, "push", "origin", "main");

      const created = await materialize("nested-linked");
      const nested = path.join(created.path, "nested", "checkout");
      await fs.mkdir(path.dirname(nested), { recursive: true });
      await git(repo, "worktree", "add", "--detach", nested, "HEAD");
      const localState = path.join(nested, "local.txt");
      await fs.writeFile(localState, "keep nested checkout state\n");
      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect(await git(created.path, "log", "HEAD", "--not", "--remotes", "--oneline")).toBe("");
      await service.acquire(created.id);

      await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

      expectOutcome(created.id, "retained-dirty");
      expect(await fs.readFile(localState, "utf8")).toBe("keep nested checkout state\n");
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(nested);
    });

    it("records unpushed retention", async () => {
      const created = await materialize("unpushed");
      await service.acquire(created.id);
      await fs.writeFile(path.join(created.path, "committed.txt"), "unpushed\n");
      await git(created.path, "add", "committed.txt");
      await git(created.path, "commit", "-m", "unpushed worktree commit");

      await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

      const retained = getRegistryWorktree(env, created.id);
      expect(retained).toMatchObject({
        runEndCleanup: { outcome: "retained-unpushed", at: now },
      });
      expect(retained?.removedAt).toBeUndefined();
      await fs.access(created.path);
    });

    it("records busy retention while a run lease is live", async () => {
      const created = await materialize("busy");
      const lease = await acquireWorktreeRunLease(created.id, { env });

      await expect(service.removeIfLossless(created.id)).resolves.toBe(false);

      expectOutcome(created.id, "retained-busy");
      await fs.access(created.path);
      await lease.release();
    });

    it("records and rethrows an unexpected removal claim failure", async () => {
      const created = await materialize("claim-failure");
      const lease = await acquireWorktreeRunLease(created.id, { env });
      const failure = new Error("synthetic removal claim failure");
      const removalClaim = vi
        .spyOn(worktreeRegistry, "claimWorktreeRemovalRow")
        .mockImplementation(() => {
          throw failure;
        });

      await expect(service.removeIfLossless(created.id)).rejects.toBe(failure);

      expect(getRegistryWorktree(env, created.id)).toMatchObject({
        runEndCleanup: {
          outcome: "failed",
          at: now,
          reason: "synthetic removal claim failure",
        },
      });
      await fs.access(created.path);
      removalClaim.mockRestore();
      await lease.release();
    });
  });

  describe("missing-path observations", () => {
    const completedGcResult = (repoRoot: string, orphansRetired = 0) => ({
      removed: [],
      orphansDeleted: 0,
      snapshotsPruned: 0,
      outcome: "completed",
      issues: [],
      issueCount: 0,
      eligibleCount: 0,
      deferredCount: 0,
      failedCount: 0,
      protectedCount: 0,
      protectionReasons: {},
      orphansRetired,
      retiredCheckoutPaths: [],
      limitsSatisfied: true,
      packsRemoved: 0,
      gitMaintenance: { repoRoot, stage: "completed", packsBefore: 0, packsAfter: 0 },
    });
    async function fixture(name: string, repoRoot = repo) {
      const created = await materializeDownstreamFixture(name, { repoRoot });
      const identity = await service.resolveRepositoryIdentity(repoRoot);
      const repositoryIdentity = {
        repoRoot: identity.repoRoot,
        repoFingerprint: identity.fingerprint,
      };
      await updateRegistryWorktree(env, created.id, { repositoryIdentity });
      return { ...created, ...repositoryIdentity };
    }

    function holdPathObservation(target: string) {
      const entered = createDeferred();
      const inspect = createDeferred();
      const sampled = createDeferred<boolean>();
      const resume = createDeferred();
      const exists = worktreeGit.worktreePathExists;
      let intercepted = false;
      vi.spyOn(worktreeGit, "worktreePathExists").mockImplementation(async (candidate) => {
        if (candidate !== target || intercepted) {
          return await exists(candidate);
        }
        intercepted = true;
        entered.resolve();
        await inspect.promise;
        const present = await exists(candidate);
        sampled.resolve(present);
        await resume.promise;
        return present;
      });
      return { entered, inspect, sampled, resume };
    }

    it("gc retires an unchanged missing checkout", async () => {
      const created = await fixture("missing");
      await git(repo, "worktree", "remove", "--force", created.path);
      expect(await service.gc()).toEqual(completedGcResult(created.repoRoot, 1));
      expect(getRegistryWorktree(env, created.id)).toEqual({ ...created, removedAt: now });
    });

    it("list preserves a checkout restored after a missing-path observation", async () => {
      const created = await fixture("restored");
      await writeFile(created.path, "README.md", "restored user changes\n");
      const gate = holdPathObservation(created.path);
      const observing = service.list();
      try {
        await gate.entered.promise;
        await service.remove({ id: created.id, reason: "test-restore" });
        gate.inspect.resolve();
        await expect(gate.sampled.promise).resolves.toBe(false);
        const restored = await service.restore({ id: created.id });
        expect(restored.lastActiveAt).toBeGreaterThan(created.lastActiveAt);
        expect(restored).toMatchObject({
          repoRoot: created.repoRoot,
          repoFingerprint: created.repoFingerprint,
        });
        gate.resume.resolve();
        const result = await observing;
        expect(getRegistryWorktree(env, created.id)).toEqual(restored);
        expect(await readText(created.path, "README.md")).toBe("restored user changes\n");
        expect(result).toEqual([restored]);
      } finally {
        gate.inspect.resolve();
        gate.resume.resolve();
        await observing;
      }
    });

    it("gc preserves a checkout rebound after a missing-path observation", async () => {
      const clone = path.join(root, "clone");
      await execFileAsync("git", ["clone", "--no-hardlinks", repo, clone]);
      await git(clone, "remote", "set-url", "origin", path.join(root, "remote.git"));
      const liveIdentity = await service.resolveRepositoryIdentity(clone);
      const staleIdentity = await service.resolveRepositoryIdentity(repo);
      const created = await fixture("rebound", liveIdentity.repoRoot);
      await updateRegistryWorktree(env, created.id, {
        repositoryIdentity: {
          repoRoot: staleIdentity.repoRoot,
          repoFingerprint: staleIdentity.fingerprint,
        },
      });
      await writeFile(created.path, "README.md", "retained user changes\n");
      const temporarilyAbsent = path.join(root, "temporarily-absent");
      await fs.rename(created.path, temporarilyAbsent);
      const gate = holdPathObservation(created.path);
      gate.inspect.resolve();
      const observing = service.gc();
      try {
        await expect(gate.sampled.promise).resolves.toBe(false);
        await fs.rename(temporarilyAbsent, created.path);
        await expect(service.removeIfLossless(created.id)).resolves.toBe(false);
        const rebound = getRegistryWorktree(env, created.id);
        expect(rebound).toMatchObject({
          repoRoot: liveIdentity.repoRoot,
          repoFingerprint: liveIdentity.fingerprint,
          lastActiveAt: created.lastActiveAt,
          runEndCleanup: { outcome: "retained-dirty" },
        });
        expect(rebound?.removedAt).toBeUndefined();
        gate.resume.resolve();
        const result = await observing;
        expect(getRegistryWorktree(env, created.id)).toEqual(rebound);
        expect(await readText(created.path, "README.md")).toBe("retained user changes\n");
        expect(result).toEqual(completedGcResult(liveIdentity.repoRoot));
      } finally {
        gate.inspect.resolve();
        gate.resume.resolve();
        await observing;
      }
    });
  });

  describe("submodule checkout", () => {
    it("keeps active submodules unpopulated when repository recursion is enabled", async () => {
      const moduleRepo = await initializeRepository(path.join(root, "module-source"));
      const moduleHead = await git(moduleRepo, "rev-parse", "HEAD");
      await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", moduleRepo, "module");
      await git(repo, "commit", "-m", "add active submodule");
      await git(repo, "push", "origin", "main");
      await git(repo, "config", "submodule.recurse", "true");
      expect(await git(repo, "config", "--bool", "submodule.module.active")).toBe("true");
      expect(await git(path.join(repo, "module"), "rev-parse", "HEAD")).toBe(moduleHead);

      useInProcessWorktreeCapacityTransport();
      const disk = fsSync.statfsSync(root);
      vi.spyOn(fsSync, "statfsSync").mockReturnValue({
        type: disk.type,
        files: disk.files,
        frsize: disk.frsize,
        ffree: disk.ffree,
        bsize: 4096,
        blocks: 1024 ** 4 / 4096,
        bavail: (100 * 1024 ** 3) / 4096,
        bfree: (100 * 1024 ** 3) / 4096,
      });
      const created = await service.create({
        repoRoot: repo,
        name: "submodules",
        baseRef: "origin/main",
      });

      expect(await git(created.path, "submodule", "status", "--", "module")).toBe(
        `-${moduleHead} module`,
      );
      await expect(fs.access(path.join(created.path, "module", ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect(
        await git(created.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
      ).toBe("origin/main");
      expect(await git(path.join(repo, "module"), "rev-parse", "HEAD")).toBe(moduleHead);
      expect(await fs.readFile(path.join(repo, "module", "README.md"), "utf8")).toBe("base\n");

      await fs.writeFile(path.join(created.path, "draft.txt"), "preserve this task\n");
      await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
        "nested git repositories cannot be snapshotted losslessly",
      );
      expect(await fs.readFile(path.join(created.path, "draft.txt"), "utf8")).toBe(
        "preserve this task\n",
      );
      expect(getRegistryWorktree(env, created.id)?.path).toBe(created.path);
    });
  });
});

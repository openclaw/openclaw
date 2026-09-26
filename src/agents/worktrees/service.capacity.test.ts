import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as backoff from "../../infra/backoff.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import * as commandExec from "../../process/exec.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { getRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import {
  useManagedWorktreeTestRepository,
  materializeManagedWorktreeFixtures,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);
const GiB = 1024 ** 3;

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

describe("ManagedWorktreeService capacity", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let availableBytes: number;
  let totalBytes: number;

  async function git(cwd: string, ...args: string[]) {
    return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
  }

  async function fill(count: number) {
    await materializeManagedWorktreeFixtures({
      env,
      stateDir,
      repoRoot: repo,
      names: Array.from({ length: count }, (_, index) => `kept-${index}`),
      now: Date.now(),
    });
  }

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worktree-capacity-")),
    );
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    // Exercise full-checkout admission; clone allowances have their own suite.
    service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const stats = fsSync.statfsSync(root);
    availableBytes = 100 * GiB;
    totalBytes = 1024 * GiB;
    vi.spyOn(fsSync, "statfsSync").mockImplementation(() => ({
      type: stats.type,
      bsize: 4096,
      bfree: Math.floor(availableBytes / 4096),
      bavail: Math.floor(availableBytes / 4096),
      blocks: totalBytes / 4096,
      files: stats.files,
      frsize: stats.frsize,
      ffree: stats.ffree,
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([20, 100, 1024])(
    "uses the same operational reserve on a %s GiB volume",
    async (total) => {
      totalBytes = total * GiB;
      availableBytes = 3 * GiB;
      const params = { repoRoot: repo, name: "fixed-reserve", baseRef: "HEAD" };
      await expect(service.create(params)).rejects.toThrow(/disk space/i);
      expect(await service.listRegistryRecords()).toEqual([]);
      expect(await git(repo, "branch", "--list", "openclaw/fixed-reserve")).toBe("");
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("fixed-reserve");

      availableBytes = 5 * GiB;
      const created = await service.create(params);
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect(await service.listRegistryRecords()).toEqual([created]);
    },
  );

  it.each(["source", "destination"] as const)(
    "refuses allocation when the separate %s volume lacks its reserve",
    async (limited) => {
      const dataRoot = path.join(root, "data");
      await fs.mkdir(dataRoot);
      service = new ManagedWorktreeService({
        env,
        getConfig: () => ({ worktreeAcceleration: false, worktreeRoot: dataRoot }),
      });
      const isData = (value: unknown) => String(value).startsWith(dataRoot);
      const stat = fsSync.statSync;
      vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
        const result = stat(...args);
        if (result) {
          result.dev = isData(args[0]) ? 2 : 1;
        }
        return result;
      });
      const stats = fsSync.statfsSync(root);
      let recovered = false;
      vi.mocked(fsSync.statfsSync).mockImplementation((target) => {
        const low = isData(target) === (limited === "destination");
        const available = (recovered ? (isData(target) ? 100 : 13) : low ? 3 : 100) * GiB;
        return {
          type: stats.type,
          bsize: stats.bsize,
          blocks: stats.blocks,
          bfree: available / 4096,
          bavail: available / 4096,
          files: stats.files,
          frsize: stats.frsize,
          ffree: stats.ffree,
        };
      });

      await expect(
        service.create({ repoRoot: repo, name: "split-volumes", baseRef: "HEAD" }),
      ).rejects.toThrow(/disk space/i);
      expect(await service.listRegistryRecords()).toEqual([]);
      expect(await git(repo, "branch", "--list", "openclaw/split-volumes")).toBe("");
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("split-volumes");

      recovered = true;
      const requestedHead = await git(repo, "rev-parse", "HEAD");
      const created = await service.create({
        repoRoot: repo,
        name: "split-volumes",
        baseRef: requestedHead,
      });
      expect(created.path.startsWith(dataRoot + path.sep)).toBe(true);
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(requestedHead);
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect(await service.listRegistryRecords()).toEqual([created]);
    },
  );

  it("budgets ignored files selected for provisioning before allocating", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "fixture.bin\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "fixture.bin\n");
    await fs.writeFile(path.join(repo, "fixture.bin"), Buffer.alloc(10 * 1024 ** 2));
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "provision ignored fixture");
    availableBytes = 4 * GiB + 8 * 1024 ** 2;
    await expect(
      service.create({ repoRoot: repo, name: "provision-space", baseRef: "HEAD" }),
    ).rejects.toThrow(/disk space/i);
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", "openclaw/provision-space")).toBe("");
  });

  it("admits the registered remote tip before materializing files and rolls back a rejected allocation", async () => {
    const originalCommit = await git(repo, "rev-parse", "HEAD");
    const payload = Buffer.alloc(16 * 1024 ** 2, 7);
    await fs.writeFile(path.join(repo, "large.bin"), payload);
    await git(repo, "add", "large.bin");
    await git(repo, "commit", "-m", "larger moving source");
    const advancedCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/remotes/origin/moving", originalCommit);
    availableBytes = 4 * GiB + 8 * 1024 ** 2;

    const branch = "openclaw/moving-base";
    let destination: string | undefined;
    let materializedBeforeAdmission = false;
    const realRun = commandExec.runCommandWithTimeout;
    const commands = vi
      .spyOn(commandExec, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        if (isWorktreeAdd(argv) && argv.includes(branch)) {
          destination = argv.at(-2);
          await git(repo, "update-ref", "refs/remotes/origin/moving", advancedCommit);
        }
        const result = await realRun(argv, options);
        if (destination && fsSync.existsSync(path.join(destination, "large.bin"))) {
          materializedBeforeAdmission = true;
        }
        return result;
      });

    const params = { repoRoot: repo, name: "moving-base", baseRef: "origin/moving" };
    await expect(service.create(params)).rejects.toThrow(/disk space/i);
    expect(destination).toBeDefined();
    expect(materializedBeforeAdmission).toBe(false);
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", branch)).toBe("");
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(destination);
    await expect(fs.stat(destination!)).rejects.toMatchObject({ code: "ENOENT" });
    commands.mockRestore();

    availableBytes = 100 * GiB;
    const created = await service.create(params);
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(advancedCommit);
    expect((await fs.readFile(path.join(created.path, "large.bin"))).equals(payload)).toBe(true);
    expect(await git(created.path, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
      "refs/remotes/origin/moving",
    );
    expect(await git(created.path, "status", "--porcelain")).toBe("");
  });

  it.each(["aborted", "closed"] as const)(
    "rolls back a new registration after caller authority is %s and permits a same-name retry",
    async (ending) => {
      const controller = new AbortController();
      const cancelled = new Error("caller stopped worktree creation");
      let closed = false;
      let destination: string | undefined;
      const params = { repoRoot: repo, name: "cancelled-registration", baseRef: "HEAD" };
      const branch = `openclaw/${params.name}`;
      const realRun = commandExec.runCommandWithTimeout;
      const commands = vi
        .spyOn(commandExec, "runCommandWithTimeout")
        .mockImplementation(async (argv, options) => {
          const result = await realRun(argv, options);
          if (isWorktreeAdd(argv) && argv.includes(branch) && result.code === 0) {
            destination = argv.at(-2);
            if (ending === "aborted") {
              controller.abort(cancelled);
            } else {
              closed = true;
            }
          }
          return result;
        });
      const creation = service.create({
        ...params,
        signal: controller.signal,
        commitGuard: () => {
          if (closed) {
            throw cancelled;
          }
        },
      });
      if (ending === "aborted") {
        await expect(creation).rejects.toMatchObject({
          code: "OPENCLAW_STATE_LEASE_ABORTED",
          cause: cancelled,
        });
      } else {
        await expect(creation).rejects.toBe(cancelled);
      }
      expect(destination).toBeDefined();
      expect(await service.listRegistryRecords()).toEqual([]);
      expect(await git(repo, "branch", "--list", branch)).toBe("");
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(destination);
      await expect(fs.stat(destination!)).rejects.toMatchObject({ code: "ENOENT" });
      commands.mockRestore();

      const retried = await service.create(params);
      expect(await fs.readFile(path.join(retried.path, "README.md"), "utf8")).toBe("base\n");
      expect(await git(retried.path, "status", "--porcelain")).toBe("");
    },
  );

  it.each(["create", "restore"] as const)(
    "preserves materialized files and their branch when %s loses allocation ownership",
    async (operation) => {
      const params = { repoRoot: repo, name: "lost-allocation", baseRef: "HEAD" };
      const branch = `openclaw/${params.name}`;
      const originalHead = await git(repo, "rev-parse", "HEAD");
      const archived = operation === "restore" ? await service.create(params) : undefined;
      if (archived) {
        await fs.writeFile(path.join(archived.path, "README.md"), "saved restore state\n");
        await service.remove({ id: archived.id, reason: "test" });
      }
      const before = await service.listRegistryRecords();
      let destination: string | undefined;
      const realRun = commandExec.runCommandWithTimeout;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const result = await realRun(argv, options);
        if (
          argv[0] === "git" &&
          argv.includes("read-tree") &&
          argv.includes("-u") &&
          result.code === 0
        ) {
          destination = argv[argv.indexOf("-C") + 1];
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
        }
        return result;
      });

      await expect(
        archived ? service.restore({ id: archived.id }) : service.create(params),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(destination).toBeDefined();
      expect(await service.listRegistryRecords()).toEqual(before);
      expect(await git(repo, "rev-parse", branch)).toBe(originalHead);
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(destination);
      expect(await fs.readFile(path.join(destination!, "README.md"), "utf8")).toBe(
        archived ? "saved restore state\n" : "base\n",
      );
    },
  );

  it("budgets repository setup separately from a small Git checkout", async () => {
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.mkdir(path.dirname(script));
    await fs.writeFile(script, '#!/bin/sh\nprintf ran > "$OPENCLAW_SOURCE_TREE_PATH/setup-ran"\n', {
      mode: 0o755,
    });
    availableBytes = 6 * GiB;
    await expect(
      service.create({ repoRoot: repo, name: "setup-budget", baseRef: "HEAD" }),
    ).rejects.toThrow(/disk space/i);
    await expect(fs.stat(path.join(repo, "setup-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.listRegistryRecords()).toEqual([]);
  });

  it("requires a readable capacity sample before creating a checkout", async () => {
    vi.mocked(fsSync.statfsSync).mockImplementation(() => {
      throw new Error("volume unavailable");
    });
    await expect(
      service.create({ repoRoot: repo, name: "unknown-space", baseRef: "HEAD" }),
    ).rejects.toThrow(/determine.*disk space|disk space.*unavailable/i);
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", "openclaw/unknown-space")).toBe("");
  });

  it("creates beyond 100 live checkouts without removing prior worktrees", async () => {
    await fill(100);
    const before = await service.listRegistryRecords();
    const created = await service.create({
      repoRoot: repo,
      name: "beyond-target",
      baseRef: "HEAD",
    });
    expect(await service.listRegistryRecords()).toHaveLength(101);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    for (const record of before) {
      expect(getRegistryWorktree(env, record.id)).toEqual(record);
      expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    }
  });

  it("serializes distinct repositories competing for disk headroom", async () => {
    const otherRepo = await initializeRepository(path.join(root, "other"));
    const otherService = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const realRun = commandExec.runCommandWithTimeout;
    let pressureInjected = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await realRun(argv, options);
      if (
        argv[0] === "git" &&
        argv.includes("read-tree") &&
        argv.includes("-u") &&
        result.code === 0
      ) {
        // The first checkout still passes its postchecks, but a second checkout
        // cannot fit its estimate. Without the shared lease both materializations can start.
        availableBytes = 4 * GiB;
        pressureInjected = true;
      }
      return result;
    });
    const outcomes = await Promise.allSettled([
      service.create({ repoRoot: repo, name: "last-one", baseRef: "HEAD" }),
      otherService.create({ repoRoot: otherRepo, name: "last-two", baseRef: "HEAD" }),
    ]);
    expect(pressureInjected).toBe(true);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          message: expect.stringMatching(/disk space/i),
        }),
      }),
    ]);
    expect(
      (await service.listRegistryRecords()).filter((record) => record.removedAt === undefined),
    ).toHaveLength(1);
    const created = (await service.listRegistryRecords())[0]!;
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    const rejectedRepo = created.repoRoot === repo ? otherRepo : repo;
    expect(await git(rejectedRepo, "branch", "--list", "openclaw/*")).toBe("");
  });

  it.each(["release", "abort", "timeout"] as const)(
    "waits beyond five minutes for allocation until %s",
    async (ending) => {
      const held = createDeferred();
      const release = createDeferred();
      const holder = withOpenClawStateLease(
        {
          scope: "core:managed-worktrees:create",
          key: "capacity",
          database: { scope: "shared", options: { env } },
          leaseMs: 60_000,
          waitMs: 0,
        },
        async () => {
          held.resolve();
          await release.promise;
        },
      );
      await held.promise;
      const controller = new AbortController();
      const realNow = performance.now.bind(performance);
      let elapsedMs = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + elapsedMs);
      const waits = vi.spyOn(backoff, "sleepWithAbort");
      let settled = false;
      const pending = service
        .create({ repoRoot: repo, name: "waiting", baseRef: "HEAD", signal: controller.signal })
        .finally(() => {
          settled = true;
        });
      const result = pending.catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(waits.mock.calls.length > 0 || settled).toBe(true));
        expect(settled).toBe(false);
        const previousWaits = waits.mock.calls.length;
        // Advance only elapsed acquisition time; keep the real holder's expiry and timers live.
        elapsedMs = 6 * 60_000;
        await vi.waitFor(() =>
          expect(waits.mock.calls.length > previousWaits || settled).toBe(true),
        );
        expect(settled, "allocation must remain pending while another owner holds the lease").toBe(
          false,
        );
        expect(await service.listRegistryRecords()).toEqual([]);
        if (ending !== "release") {
          if (ending === "abort") {
            controller.abort(new Error("cancel queued worktree"));
          } else {
            elapsedMs = 11 * 60_000;
          }
          await vi.waitFor(() => expect(settled).toBe(true));
          await expect(result).resolves.toMatchObject({
            code: ending === "abort" ? "OPENCLAW_STATE_LEASE_ABORTED" : "OPENCLAW_STATE_LEASE_HELD",
          });
          expect(await service.listRegistryRecords()).toEqual([]);
          expect(await git(repo, "branch", "--list", "openclaw/waiting")).toBe("");
        } else {
          release.resolve();
          await holder;
          const created = await pending;
          expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
          expect(await service.listRegistryRecords()).toEqual([created]);
        }
      } finally {
        controller.abort();
        release.resolve();
        await Promise.allSettled([holder, pending]);
        waits.mockRestore();
        clock.mockRestore();
      }
    },
  );

  it("reuses a valid owned checkout at the cleanup target and below the reserve", async () => {
    const params = {
      repoRoot: repo,
      name: "owned",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:owned",
    };
    const created = await service.create(params);
    await fill(99);
    availableBytes = GiB;
    expect(await service.create(params)).toEqual(created);
    expect(await service.listRegistryRecords()).toHaveLength(100);
  });

  it.each(["sufficient", "insufficient"])(
    "restores beyond 100 live checkouts only with %s disk space",
    async (space) => {
      const created = await service.create({ repoRoot: repo, name: "restore", baseRef: "HEAD" });
      await fs.writeFile(path.join(created.path, "README.md"), "dirty tracked file\n");
      await fs.writeFile(path.join(created.path, "uncommitted.txt"), "keep me\n");
      await service.remove({ id: created.id, reason: "archive" });
      const before = getRegistryWorktree(env, created.id);
      await fill(100);
      const kept = (await service.listRegistryRecords()).filter(
        (record) => record.id !== created.id,
      );
      if (space === "sufficient") {
        const restored = await service.restore({ id: created.id });
        expect(restored).toMatchObject({
          id: created.id,
          path: created.path,
          branch: created.branch,
        });
        expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
        expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
          "dirty tracked file\n",
        );
        expect(await fs.readFile(path.join(restored.path, "uncommitted.txt"), "utf8")).toBe(
          "keep me\n",
        );
        expect(await git(restored.path, "status", "--porcelain")).toContain("M README.md");
        expect(await git(restored.path, "rev-parse", "HEAD")).toBe(
          await git(repo, "rev-parse", "HEAD"),
        );
      } else {
        availableBytes = GiB;
        await expect(service.restore({ id: created.id })).rejects.toThrow(/disk space/i);
        expect(getRegistryWorktree(env, created.id)).toEqual(before);
        await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const record of kept) {
        expect(getRegistryWorktree(env, record.id)).toEqual(record);
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
      }
      expect(await git(repo, "show", `${before!.snapshotRef}:uncommitted.txt`)).toBe("keep me");
    },
  );

  it("checks space again before repository setup and rolls back its unbound checkout", async () => {
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    const marker = path.join(repo, "setup-ran");
    await fs.mkdir(path.dirname(script));
    await fs.writeFile(script, '#!/bin/sh\nprintf ran > "$OPENCLAW_SOURCE_TREE_PATH/setup-ran"\n', {
      mode: 0o755,
    });
    const realRun = commandExec.runCommandWithTimeout;
    let pressureInjected = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await realRun(argv, options);
      if (
        argv[0] === "git" &&
        argv.includes("read-tree") &&
        argv.includes("-u") &&
        result.code === 0
      ) {
        availableBytes = GiB;
        pressureInjected = true;
      }
      return result;
    });
    await expect(
      service.create({ repoRoot: repo, name: "setup-space", baseRef: "HEAD" }),
    ).rejects.toThrow(/disk space/i);
    expect(pressureInjected).toBe(true);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", "openclaw/setup-space")).toBe("");
  });

  it("archives a large unchanged checkout with space for only its snapshot writes", async () => {
    const unchanged = Buffer.alloc(16 * 1024 ** 2, 7);
    await fs.writeFile(path.join(repo, "unchanged.bin"), unchanged);
    await git(repo, "add", "unchanged.bin");
    await git(repo, "commit", "-m", "large unchanged content");
    const created = await service.create({
      repoRoot: repo,
      name: "snapshot-delta",
      baseRef: "HEAD",
    });
    await git(created.path, "config", "diff.autoRefreshIndex", "false");
    await fs.writeFile(path.join(created.path, "uncommitted.txt"), "preserved delta\n");
    availableBytes = 144 * 1024 ** 2;

    await service.remove({ id: created.id, reason: "archive" });

    const removed = getRegistryWorktree(env, created.id)!;
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "show", `${removed.snapshotRef}:uncommitted.txt`)).toBe(
      "preserved delta",
    );
    availableBytes = 100 * GiB;
    const restored = await service.restore({ id: created.id });
    expect((await fs.readFile(path.join(restored.path, "unchanged.bin"))).equals(unchanged)).toBe(
      true,
    );
    expect(await fs.readFile(path.join(restored.path, "uncommitted.txt"), "utf8")).toBe(
      "preserved delta\n",
    );
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "budgets snapshot writes hidden by %s in the source index",
    async (flag) => {
      const created = await service.create({
        repoRoot: repo,
        name: "hidden-delta",
        baseRef: "HEAD",
      });
      await git(created.path, "update-index", flag, "README.md");
      await fs.writeFile(path.join(created.path, "README.md"), Buffer.alloc(16 * 1024 ** 2, 8));
      availableBytes = 144 * 1024 ** 2;

      await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
        /disk space/i,
      );

      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
      expect((await fs.stat(path.join(created.path, "README.md"))).size).toBe(16 * 1024 ** 2);
    },
  );

  it("preserves dirty work when there is insufficient room for its safety snapshot", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "snapshot-space",
      baseRef: "HEAD",
    });
    await fs.writeFile(path.join(created.path, "uncommitted.txt"), "only copy\n");
    availableBytes = 64 * 1024 ** 2;
    await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
      /disk space/i,
    );
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(path.join(created.path, "uncommitted.txt"), "utf8")).toBe(
      "only copy\n",
    );
    expect(await git(repo, "branch", "--list", "--format=%(refname)", created.branch)).toBe(
      `refs/heads/${created.branch}`,
    );
  });

  it("rejects reuse of a broken Git link without destroying its work", async () => {
    const params = {
      repoRoot: repo,
      name: "broken-link",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:broken",
    };
    const created = await service.create(params);
    await fs.writeFile(path.join(created.path, "uncommitted.txt"), "only copy\n");
    const marker = await fs.readFile(path.join(created.path, ".git"), "utf8");
    await fs.rm(marker.trim().slice("gitdir: ".length), { recursive: true });
    await expect(service.create(params)).rejects.toThrow(
      /Git metadata.*preserved|preserved.*Git metadata/i,
    );
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(path.join(created.path, "uncommitted.txt"), "utf8")).toBe(
      "only copy\n",
    );
  });
});

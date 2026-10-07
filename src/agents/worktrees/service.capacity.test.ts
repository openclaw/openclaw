import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as backoff from "../../infra/backoff.js";
import * as commandExec from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import * as allocation from "./allocation.js";
import { captureWorktreeMutationHeartbeat } from "./allocation.test-support.js";
import * as capacity from "./capacity.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";
import { readPendingWorktrees } from "./pending-slots.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

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

  async function git(cwd: string, ...args: string[]) {
    return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
  }

  beforeEach(async () => {
    useInProcessWorktreeCapacityTransport();
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
    vi.spyOn(fsSync, "statfsSync").mockImplementation(() => ({
      type: stats.type,
      bsize: 4096,
      bfree: Math.floor(availableBytes / 4096),
      bavail: Math.floor(availableBytes / 4096),
      blocks: (1024 * GiB) / 4096,
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

  it.for(["ample", "constrained"] as const)(
    "admits an unrelated create during retirement only with %s disk space",
    async (space, { signal }) => {
      const retiring = await service.create({ repoRoot: repo, name: "retiring", baseRef: "HEAD" });
      await fs.writeFile(path.join(retiring.path, "draft.bin"), Buffer.alloc(8 * 1024 ** 2, 7));
      availableBytes = space === "ample" ? 100 * GiB : 4 * GiB + 10 * 1024 ** 2;
      const deleting = createDeferred();
      const release = createDeferred();
      const waiting = createDeferred();
      const waitCapacity = allocation.waitForWorktreeCapacity;
      vi.spyOn(allocation, "waitForWorktreeCapacity").mockImplementation(async (...args) => {
        waiting.resolve();
        return await waitCapacity(...args);
      });
      const runCommand = commandExec.runCommandWithTimeout;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const command = argv.indexOf("worktree");
        if (command >= 0 && argv[command + 1] === "remove" && argv.includes(retiring.path)) {
          deleting.resolve();
          await release.promise;
        }
        return await runCommand(argv, options);
      });
      const removal = service.remove({ id: retiring.id, reason: "owner-gc" });
      const create = () => service.create({ repoRoot: repo, name: "parallel", baseRef: "HEAD" });
      let creation: ReturnType<typeof create> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(deleting.promise, removal, "retirement never reached deletion"),
          signal,
        );
        creation = create();
        if (space === "constrained") {
          await withinTest(
            awaitGateBeforeSettlement(
              waiting.promise,
              creation,
              "creation did not wait for disk admission",
            ),
            signal,
          );
          expect(await git(repo, "branch", "--list", "openclaw/parallel")).toBe("");
        } else {
          const created = await withinTest(creation, signal);
          expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
        }
        expect(getRegistryWorktree(env, retiring.id)?.removedAt).toBeUndefined();
        expect(await fs.stat(retiring.path)).toBeDefined();
      } finally {
        release.resolve();
        await Promise.allSettled([removal, creation]);
      }
      expect(getRegistryWorktree(env, retiring.id)?.removedAt).toEqual(expect.any(Number));
      if (space === "constrained") {
        const created = await creation!;
        expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      }
    },
  );

  it.for(["linked create", "borrowed create", "borrowed restore"] as const)(
    "retains managed Git sources until %s settles below the count cap",
    async (operation, { signal }) => {
      const source = await service.create({ repoRoot: repo, name: "source", baseRef: "HEAD" });
      let consumerRoot = source.path;
      if (operation !== "linked create") {
        const donor = path.join(source.path, "donor");
        consumerRoot = path.join(root, "borrower");
        await git(root, "clone", "--no-local", "--", repo, donor);
        await git(root, "clone", "--shared", "--", donor, consumerRoot);
        expect(
          (
            await fs.readFile(path.join(consumerRoot, ".git/objects/info/alternates"), "utf8")
          ).trim(),
        ).toBe(path.join(donor, ".git/objects"));
      }
      const consumer = { repoRoot: consumerRoot, name: "consumer", baseRef: "HEAD" };
      const retired = operation === "borrowed restore" ? await service.create(consumer) : undefined;
      if (retired) {
        await fs.writeFile(path.join(retired.path, "saved.txt"), "saved edits\n");
        await service.remove({ id: retired.id, reason: "owner-gc" });
      }
      const adding = createDeferred();
      const release = createDeferred();
      const runCommand = commandExec.runCommandWithTimeout;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        if (isWorktreeAdd(argv)) {
          adding.resolve();
          await release.promise;
        }
        return await runCommand(argv, options);
      });
      const creation = retired ? service.restore({ id: retired.id }) : service.create(consumer);
      let removal: ReturnType<typeof service.remove> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            adding.promise,
            creation,
            "creation never admitted its checkout",
          ),
          signal,
        );
        removal = service.remove({ id: source.id, reason: "owner-gc", allowSnapshotLoss: true });
        await expect(withinTest(removal, signal)).rejects.toThrow(/busy|locked/);
        expect(getRegistryWorktree(env, source.id)?.removedAt).toBeUndefined();
      } finally {
        release.resolve();
        await Promise.allSettled([creation, removal]);
      }
      const created = await creation;
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      expect(await fs.stat(source.path)).toBeDefined();
      if (retired) {
        expect(await fs.readFile(path.join(created.path, "saved.txt"), "utf8")).toBe(
          "saved edits\n",
        );
      }
    },
  );

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
    "preserves materialized files and their branch when %s loses checkout ownership",
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
      const revokeCheckout = captureWorktreeMutationHeartbeat();
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
          const checkoutId =
            archived?.id ??
            (await readPendingWorktrees(env)).find(({ record }) => record.path === destination)
              ?.record.id;
          assert(checkoutId);
          await revokeCheckout(checkoutId);
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

  it.each(["none", "files", "registration", "unknown"])(
    "recovers an unprepared branch after lease loss (changed=%s)",
    async (changed) => {
      const params = {
        repoRoot: repo,
        name: "retry-hydration",
        baseRef: "HEAD",
        ownerKind: "session" as const,
        ownerId: "agent:main:retry-hydration",
      };
      let sourceHeld = false;
      let cleanupEntered = false;
      const recoveryRegistryReads: string[] = [];
      let destination: string | undefined;
      const revokeCheckout = captureWorktreeMutationHeartbeat();
      const nativeOutcomeUnknown = Object.assign(new Error("native hydration outcome unknown"), {
        code: "outcome-unknown",
      });
      vi.spyOn(capacity, "estimateWorktreeGitBytes").mockImplementationOnce(async () => {
        expect(sourceHeld).toBe(true);
        // Hydration starts after Git has registered the new branch but before publication.
        expect(await git(repo, "branch", "--list", "openclaw/retry-hydration")).not.toBe("");
        const listing = await git(repo, "worktree", "list", "--porcelain");
        destination = listing
          .split("\n")
          .find((line) => line.startsWith("worktree ") && line.endsWith("retry-hydration"))
          ?.slice("worktree ".length);
        const pending = (await readPendingWorktrees(env)).find(
          ({ record }) => record.path === destination,
        );
        assert(pending);
        expect(pending.record.path).toBe(destination);
        await revokeCheckout(pending.record.id);
        if (changed === "unknown") {
          throw nativeOutcomeUnknown;
        }
        return 4096;
      });

      const creation = service.create({
        ...params,
        withSource: async (run) => {
          sourceHeld = true;
          try {
            return await run({ assertCurrent() {} });
          } finally {
            sourceHeld = false;
          }
        },
        withRollback: async (run) => {
          // Recovery must release source custody before taking allocation → source again.
          expect(sourceHeld).toBe(false);
          cleanupEntered = true;
          if (changed === "files") {
            await fs.writeFile(path.join(destination!, "keep.txt"), "new owner data\n");
          } else if (changed === "registration") {
            await fs.writeFile(
              path.join(destination!, ".git"),
              `gitdir: ${path.join(repo, ".git")}\n`,
            );
          }
          const sql = observeHostDataSql();
          try {
            return await run(() => {});
          } finally {
            recoveryRegistryReads.push(
              ...sql.queries.filter((query) => /\bfrom\s+"?worktrees"?\b/i.test(query)),
            );
            sql.restore();
          }
        },
      });
      if (changed === "unknown") {
        const failure = await creation.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({ code: "outcome-unknown" });
        const causes = collectNestedErrorCandidates(failure);
        expect(causes).toContain(nativeOutcomeUnknown);
        expect(causes).toContainEqual(
          expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
        );
      } else {
        await expect(creation).rejects.toThrow(/was lost/);
      }
      expect(recoveryRegistryReads).toEqual([]);
      expect(await service.listRegistryRecords()).toEqual([]);
      if (changed === "unknown") {
        expect(cleanupEntered).toBe(false);
        expect(await fs.stat(destination!)).toBeDefined();
        expect(await git(repo, "branch", "--list", "openclaw/retry-hydration")).not.toBe("");
        return;
      }
      if (changed === "files") {
        expect(await fs.readFile(path.join(destination!, "keep.txt"), "utf8")).toBe(
          "new owner data\n",
        );
      }
      if (changed !== "none") {
        expect(cleanupEntered).toBe(true);
        expect(await fs.stat(destination!)).toBeDefined();
        expect(await git(repo, "branch", "--list", "openclaw/retry-hydration")).not.toBe("");
        return;
      }
      const branchBeforeRetry = await git(repo, "branch", "--list", "openclaw/retry-hydration");
      const retried = await service.create(params);
      expect(cleanupEntered).toBe(true);
      expect(branchBeforeRetry).toBe("");
      expect(retried.ownerId).toBe(params.ownerId);
      expect(await fs.readFile(path.join(retried.path, "README.md"), "utf8")).toBe("base\n");
      expect(await service.listRegistryRecords()).toEqual([retried]);
    },
  );

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

  it.for(["release", "abort"] as const)(
    "waits beyond five minutes for allocation until %s",
    async (ending, { signal }) => {
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
      const waiting = createDeferred();
      const waitingAfterAdvance = createDeferred();
      const sleepWithAbort = backoff.sleepWithAbort;
      const waits = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (...args) => {
        (elapsedMs === 0 ? waiting : waitingAfterAdvance).resolve();
        await sleepWithAbort(...args);
      });
      let settled = false;
      const pending = service
        .create({ repoRoot: repo, name: "waiting", baseRef: "HEAD", signal: controller.signal })
        .finally(() => {
          settled = true;
        });
      const result = pending.catch((error: unknown) => error);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            waiting.promise,
            pending,
            "allocation settled before waiting for its holder",
          ),
          signal,
        );
        expect(settled).toBe(false);
        // Advance only elapsed acquisition time; keep the real holder's expiry and timers live.
        elapsedMs = 6 * 60_000;
        await withinTest(
          awaitGateBeforeSettlement(
            waitingAfterAdvance.promise,
            pending,
            "allocation settled before waiting beyond five minutes",
          ),
          signal,
        );
        expect(settled, "allocation must remain pending while another owner holds the lease").toBe(
          false,
        );
        expect(await service.listRegistryRecords()).toEqual([]);
        if (ending === "abort") {
          controller.abort(new Error("cancel queued worktree"));
          await withinTest(result, signal);
          expect(settled).toBe(true);
          await expect(result).resolves.toMatchObject({
            code: "OPENCLAW_STATE_LEASE_ABORTED",
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

  it("reconciles a missing owned checkout only after any removal claim has settled", async () => {
    const params = {
      repoRoot: repo,
      suggestedName: "missing-owned",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:missing-owned",
    };
    const original = await service.create(params);
    await git(repo, "worktree", "remove", "--force", original.path);
    const token = "pending-removal";
    await claimWorktreeRemoval(env, { worktreeId: original.id, token });
    try {
      await expect(service.create(params)).rejects.toThrow(/removed|removal|busy/);
      expect(getRegistryWorktree(env, original.id)?.removedAt).toBeUndefined();
    } finally {
      await abortWorktreeRemoval(env, original.id, token);
    }

    const replacement = await service.create(params);
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.name).toBe("missing-owned-2");
    expect(await fs.readFile(path.join(replacement.path, "README.md"), "utf8")).toBe("base\n");
    expect(getRegistryWorktree(env, original.id)?.removedAt).toEqual(expect.any(Number));
    expect(
      (await service.listRegistryRecords()).filter((record) => record.removedAt === undefined),
    ).toEqual([replacement]);
  });

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

  it("budgets snapshot writes hidden by assume-unchanged in the source index", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "hidden-delta",
      baseRef: "HEAD",
    });
    await git(created.path, "update-index", "--assume-unchanged", "README.md");
    await fs.writeFile(path.join(created.path, "README.md"), Buffer.alloc(16 * 1024 ** 2, 8));
    availableBytes = 144 * 1024 ** 2;

    await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
      /disk space/i,
    );

    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect((await fs.stat(path.join(created.path, "README.md"))).size).toBe(16 * 1024 ** 2);
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

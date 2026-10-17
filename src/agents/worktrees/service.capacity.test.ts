import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import * as backoff from "../../infra/backoff.js";
import * as commandExec from "../../process/exec.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import * as allocation from "./allocation.js";
import { captureWorktreeMutationHeartbeat } from "./allocation.test-support.js";
import * as capacity from "./capacity.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";
import { readPendingWorktrees } from "./pending-slots.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import {
  expectFile,
  expectMissing,
  writeFile,
  atGate,
  afterCommand,
  git,
  useServiceFixture,
} from "./service-scenarios.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

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
  beforeEach(() => {
    useInProcessWorktreeCapacityTransport();
  });
  const f = useServiceFixture(initializeRepository, {
    prefix: "openclaw-worktree-capacity-",
    getConfig: () => ({ worktreeAcceleration: false }),
  });
  let availableBytes: number;

  function onHydrated(effect: (destination: string) => Promise<void> | void) {
    return afterCommand(commandExec, async (argv, result) => {
      if (
        argv[0] === "git" &&
        argv.includes("read-tree") &&
        argv.includes("-u") &&
        result.code === 0
      ) {
        await effect(argv[argv.indexOf("-C") + 1]!);
      }
    });
  }

  async function expectRolledBack(name: string, destination?: string) {
    expect(await f.service.listRegistryRecords()).toEqual([]);
    expect(await git(f.repo, "branch", "--list", `openclaw/${name}`)).toBe("");
    if (destination) {
      expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(destination);
      await expectMissing(destination);
    }
  }

  beforeEach(async () => {
    const stats = fsSync.statfsSync(f.root);
    availableBytes = 100 * GiB;
    vi.spyOn(fsSync, "statfsSync").mockImplementation(() => ({
      ...stats,
      bsize: 4096,
      bfree: Math.floor(availableBytes / 4096),
      bavail: Math.floor(availableBytes / 4096),
      blocks: (1024 * GiB) / 4096,
    }));
  });

  it.for(["ample", "constrained"] as const)(
    "admits an unrelated create during retirement only with %s disk space",
    async (space, { signal }) => {
      const retiring = await f.create("retiring");
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
      const removal = f.service.remove({ id: retiring.id, reason: "owner-gc" });
      const create = () => f.create("parallel");
      let creation: ReturnType<typeof create> | undefined;
      try {
        await atGate(deleting.promise, removal, "retirement never reached deletion", signal);
        creation = create();
        if (space === "constrained") {
          await atGate(
            waiting.promise,
            creation,
            "creation did not wait for disk admission",
            signal,
          );
          expect(await git(f.repo, "branch", "--list", "openclaw/parallel")).toBe("");
        } else {
          const created = await withinTest(creation, signal);
          await expectFile(created.path, "README.md", "base\n");
        }
        expect(getRegistryWorktree(f.env, retiring.id)?.removedAt).toBeUndefined();
        expect(await fs.stat(retiring.path)).toBeDefined();
      } finally {
        release.resolve();
        await Promise.allSettled([removal, creation]);
      }
      expect(getRegistryWorktree(f.env, retiring.id)?.removedAt).toEqual(expect.any(Number));
      if (space === "constrained") {
        const created = await creation!;
        await expectFile(created.path, "README.md", "base\n");
      }
    },
  );

  it.for(["linked create", "borrowed create", "borrowed restore", "nested destination"] as const)(
    "retains managed dependencies until %s settles below the count cap",
    async (operation, { signal }) => {
      const source = await f.create("source");
      let consumerRoot = source.path;
      if (operation === "nested destination") {
        consumerRoot = f.repo;
        f.service = new ManagedWorktreeService({
          env: f.env,
          getConfig: () => ({
            worktreeAcceleration: false,
            worktreeRoot: path.join(source.path, "nested"),
          }),
        });
      } else if (operation !== "linked create") {
        const donor = path.join(source.path, "donor");
        consumerRoot = path.join(f.root, "borrower");
        await git(f.root, "clone", "--no-local", "--", f.repo, donor);
        await git(f.root, "clone", "--shared", "--", donor, consumerRoot);
        expect(
          (
            await fs.readFile(path.join(consumerRoot, ".git/objects/info/alternates"), "utf8")
          ).trim(),
        ).toBe(path.join(donor, ".git/objects"));
      }
      const consumer = { repoRoot: consumerRoot, name: "consumer", baseRef: "HEAD" };
      const retired =
        operation === "borrowed restore" ? await f.service.create(consumer) : undefined;
      if (retired) {
        await writeFile(retired.path, "saved.txt", "saved edits\n");
        await f.service.remove({ id: retired.id, reason: "owner-gc" });
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
      const creation = retired ? f.service.restore({ id: retired.id }) : f.service.create(consumer);
      let removal: ReturnType<typeof f.service.remove> | undefined;
      try {
        await atGate(adding.promise, creation, "creation never admitted its checkout", signal);
        removal = f.service.remove({ id: source.id, reason: "owner-gc", allowSnapshotLoss: true });
        await expect(withinTest(removal, signal)).rejects.toThrow(/busy|locked/);
        expect(getRegistryWorktree(f.env, source.id)?.removedAt).toBeUndefined();
      } finally {
        release.resolve();
        await Promise.allSettled([creation, removal]);
      }
      const created = await creation;
      await expectFile(created.path, "README.md", "base\n");
      expect(await fs.stat(source.path)).toBeDefined();
      if (retired) {
        await expectFile(created.path, "saved.txt", "saved edits\n");
      }
    },
  );

  it.each(["source", "destination"] as const)(
    "refuses allocation when the separate %s volume lacks its reserve",
    async (limited) => {
      const dataRoot = path.join(f.root, "data");
      await fs.mkdir(dataRoot);
      f.service = new ManagedWorktreeService({
        env: f.env,
        getConfig: () => ({ worktreeAcceleration: false, worktreeRoot: dataRoot }),
      });
      const isData = (value: unknown) => String(value).startsWith(dataRoot);
      const stat = fsSync.statSync;
      vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
        const result = stat(...args);
        if (result?.isDirectory()) {
          result.dev = isData(args[0]) ? 2 : 1;
        }
        return result;
      });
      const stats = fsSync.statfsSync(f.root);
      let recovered = false;
      vi.mocked(fsSync.statfsSync).mockImplementation((target) => {
        const low = isData(target) === (limited === "destination");
        const available = (recovered ? (isData(target) ? 100 : 13) : low ? 3 : 100) * GiB;
        return {
          ...stats,
          bfree: available / 4096,
          bavail: available / 4096,
        };
      });

      await expect(f.create("split-volumes")).rejects.toThrow(/disk space/i);
      expect(await f.service.listRegistryRecords()).toEqual([]);
      expect(await git(f.repo, "branch", "--list", "openclaw/split-volumes")).toBe("");
      expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain("split-volumes");

      recovered = true;
      const requestedHead = await git(f.repo, "rev-parse", "HEAD");
      const created = await f.service.create({
        repoRoot: f.repo,
        name: "split-volumes",
        baseRef: requestedHead,
      });
      expect(created.path.startsWith(dataRoot + path.sep)).toBe(true);
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(requestedHead);
      await expectFile(created.path, "README.md", "base\n");
      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect(await f.service.listRegistryRecords()).toEqual([created]);
    },
  );

  it("admits the registered remote tip before materializing files and rolls back a rejected allocation", async () => {
    const originalCommit = await git(f.repo, "rev-parse", "HEAD");
    const payload = Buffer.alloc(16 * 1024 ** 2, 7);
    await writeFile(f.repo, "large.bin", payload);
    await git(f.repo, "add", "large.bin");
    await git(f.repo, "commit", "-m", "larger moving source");
    const advancedCommit = await git(f.repo, "rev-parse", "HEAD");
    await git(f.repo, "update-ref", "refs/remotes/origin/moving", originalCommit);
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
          await git(f.repo, "update-ref", "refs/remotes/origin/moving", advancedCommit);
        }
        const result = await realRun(argv, options);
        if (destination && fsSync.existsSync(path.join(destination, "large.bin"))) {
          materializedBeforeAdmission = true;
        }
        return result;
      });

    const params = { repoRoot: f.repo, name: "moving-base", baseRef: "origin/moving" };
    await expect(f.service.create(params)).rejects.toThrow(/disk space/i);
    expect(destination).toBeDefined();
    expect(materializedBeforeAdmission).toBe(false);
    await expectRolledBack(params.name, destination!);
    commands.mockRestore();

    availableBytes = 100 * GiB;
    const created = await f.service.create(params);
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
      const params = { repoRoot: f.repo, name: "cancelled-registration", baseRef: "HEAD" };
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
      const creation = f.service.create({
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
      await expectRolledBack(params.name, destination!);
      commands.mockRestore();

      const retried = await f.service.create(params);
      await expectFile(retried.path, "README.md", "base\n");
      expect(await git(retried.path, "status", "--porcelain")).toBe("");
    },
  );

  it.each(["create", "restore"] as const)(
    "preserves materialized files and their branch when %s loses checkout ownership",
    async (operation) => {
      const params = { repoRoot: f.repo, name: "lost-allocation", baseRef: "HEAD" };
      const branch = `openclaw/${params.name}`;
      const originalHead = await git(f.repo, "rev-parse", "HEAD");
      const archived = operation === "restore" ? await f.service.create(params) : undefined;
      if (archived) {
        await writeFile(archived.path, "README.md", "saved restore state\n");
        await f.service.remove({ id: archived.id, reason: "test" });
      }
      const before = await f.service.listRegistryRecords();
      const revokeCheckout = captureWorktreeMutationHeartbeat();
      let destination: string | undefined;
      onHydrated(async (checkoutPath) => {
        destination = checkoutPath;
        const checkoutId =
          archived?.id ??
          (await readPendingWorktrees(f.env)).find(({ record }) => record.path === destination)
            ?.record.id;
        assert(checkoutId);
        await revokeCheckout(checkoutId);
      });

      await expect(
        archived ? f.service.restore({ id: archived.id }) : f.service.create(params),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(destination).toBeDefined();
      expect(await f.service.listRegistryRecords()).toEqual(before);
      expect(await git(f.repo, "rev-parse", branch)).toBe(originalHead);
      expect(await git(f.repo, "worktree", "list", "--porcelain")).toContain(destination);
      expect(await fs.readFile(path.join(destination!, "README.md"), "utf8")).toBe(
        archived ? "saved restore state\n" : "base\n",
      );
    },
  );

  it("preserves an unprepared checkout when native hydration settlement is unknown", async () => {
    const params = {
      repoRoot: f.repo,
      name: "retry-hydration",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:retry-hydration",
    };
    let destination: string | undefined;
    const revokeCheckout = captureWorktreeMutationHeartbeat();
    const nativeOutcomeUnknown = Object.assign(new Error("native hydration outcome unknown"), {
      code: "outcome-unknown",
    });
    vi.spyOn(capacity, "estimateWorktreeGitBytes").mockImplementationOnce(async () => {
      const listing = await git(f.repo, "worktree", "list", "--porcelain");
      destination = listing
        .split("\n")
        .find((line) => line.startsWith("worktree ") && line.endsWith("retry-hydration"))
        ?.slice("worktree ".length);
      const pending = (await readPendingWorktrees(f.env)).find(
        ({ record }) => record.path === destination,
      );
      assert(pending);
      await revokeCheckout(pending.record.id);
      throw nativeOutcomeUnknown;
    });

    const failure = await f.service.create(params).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "outcome-unknown" });
    const causes = collectNestedErrorCandidates(failure);
    expect(causes).toContain(nativeOutcomeUnknown);
    expect(causes).toContainEqual(expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }));
    expect(await f.service.listRegistryRecords()).toEqual([]);
    expect(destination).toBeDefined();
    expect(await fs.stat(destination!)).toBeDefined();
    expect(await git(f.repo, "branch", "--list", "openclaw/retry-hydration")).not.toBe("");
  });

  it("requires a readable capacity sample before creating a checkout", async () => {
    vi.mocked(fsSync.statfsSync).mockImplementation(() => {
      throw new Error("volume unavailable");
    });
    await expect(f.create("unknown-space")).rejects.toThrow(
      /determine.*disk space|disk space.*unavailable/i,
    );
    await expectRolledBack("unknown-space");
  });

  it("serializes distinct repositories competing for disk headroom", async () => {
    const otherRepo = await initializeRepository(path.join(f.root, "other"));
    const otherService = new ManagedWorktreeService({
      env: f.env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    let pressureInjected = false;
    onHydrated(() => {
      // The first checkout still passes its postchecks, but a second checkout
      // cannot fit its estimate. Without the shared lease both materializations can start.
      availableBytes = 4 * GiB;
      pressureInjected = true;
    });
    const outcomes = await Promise.allSettled([
      f.create("last-one"),
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
      (await f.service.listRegistryRecords()).filter((record) => record.removedAt === undefined),
    ).toHaveLength(1);
    const created = (await f.service.listRegistryRecords())[0]!;
    await expectFile(created.path, "README.md", "base\n");
    const rejectedRepo = created.repoRoot === f.repo ? otherRepo : f.repo;
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
          database: { scope: "shared", options: { env: f.env } },
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
      const pending = f.service
        .create({ repoRoot: f.repo, name: "waiting", baseRef: "HEAD", signal: controller.signal })
        .finally(() => {
          settled = true;
        });
      const result = pending.catch((error: unknown) => error);
      try {
        await atGate(
          waiting.promise,
          pending,
          "allocation settled before waiting for its holder",
          signal,
        );
        expect(settled).toBe(false);
        // Advance only elapsed acquisition time; keep the real holder's expiry and timers live.
        elapsedMs = 6 * 60_000;
        await atGate(
          waitingAfterAdvance.promise,
          pending,
          "allocation settled before waiting beyond five minutes",
          signal,
        );
        expect(settled, "allocation must remain pending while another owner holds the lease").toBe(
          false,
        );
        expect(await f.service.listRegistryRecords()).toEqual([]);
        if (ending === "abort") {
          controller.abort(new Error("cancel queued worktree"));
          await withinTest(result, signal);
          expect(settled).toBe(true);
          await expect(result).resolves.toMatchObject({
            code: "OPENCLAW_STATE_LEASE_ABORTED",
          });
          expect(await f.service.listRegistryRecords()).toEqual([]);
          expect(await git(f.repo, "branch", "--list", "openclaw/waiting")).toBe("");
        } else {
          release.resolve();
          await holder;
          const created = await pending;
          await expectFile(created.path, "README.md", "base\n");
          expect(await f.service.listRegistryRecords()).toEqual([created]);
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
      repoRoot: f.repo,
      suggestedName: "missing-owned",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:missing-owned",
    };
    const original = await f.service.create(params);
    await git(f.repo, "worktree", "remove", "--force", original.path);
    const token = "pending-removal";
    await claimWorktreeRemoval(f.env, { worktreeId: original.id, token });
    try {
      await expect(f.service.create(params)).rejects.toThrow(/removed|removal|busy/);
      expect(getRegistryWorktree(f.env, original.id)?.removedAt).toBeUndefined();
    } finally {
      await abortWorktreeRemoval(f.env, original.id, token);
    }

    const replacement = await f.service.create(params);
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.name).toBe("missing-owned-2");
    await expectFile(replacement.path, "README.md", "base\n");
    expect(getRegistryWorktree(f.env, original.id)?.removedAt).toEqual(expect.any(Number));
    expect(
      (await f.service.listRegistryRecords()).filter((record) => record.removedAt === undefined),
    ).toEqual([replacement]);
  });

  it("checks space again before repository setup and rolls back its unbound checkout", async () => {
    const script = path.join(f.repo, ".openclaw", "worktree-setup.sh");
    const marker = path.join(f.repo, "setup-ran");
    await fs.mkdir(path.dirname(script));
    await fs.writeFile(script, '#!/bin/sh\nprintf ran > "$OPENCLAW_SOURCE_TREE_PATH/setup-ran"\n', {
      mode: 0o755,
    });
    let pressureInjected = false;
    onHydrated(() => {
      availableBytes = GiB;
      pressureInjected = true;
    });
    await expect(f.create("setup-space")).rejects.toThrow(/disk space/i);
    expect(pressureInjected).toBe(true);
    await expectMissing(marker);
    await expectRolledBack("setup-space");
  });

  it("archives a large unchanged checkout with space for only its snapshot writes", async () => {
    const unchanged = Buffer.alloc(16 * 1024 ** 2, 7);
    await writeFile(f.repo, "unchanged.bin", unchanged);
    await git(f.repo, "add", "unchanged.bin");
    await git(f.repo, "commit", "-m", "large unchanged content");
    const created = await f.create("snapshot-delta");
    await git(created.path, "config", "diff.autoRefreshIndex", "false");
    await writeFile(created.path, "uncommitted.txt", "preserved delta\n");
    availableBytes = 144 * 1024 ** 2;

    await f.service.remove({ id: created.id, reason: "archive" });

    const removed = getRegistryWorktree(f.env, created.id)!;
    await expectMissing(created.path);
    expect(await git(f.repo, "show", `${removed.snapshotRef}:uncommitted.txt`)).toBe(
      "preserved delta",
    );
    availableBytes = 100 * GiB;
    const restored = await f.service.restore({ id: created.id });
    expect((await fs.readFile(path.join(restored.path, "unchanged.bin"))).equals(unchanged)).toBe(
      true,
    );
    await expectFile(restored.path, "uncommitted.txt", "preserved delta\n");
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "budgets snapshot writes hidden by %s in the source index",
    async (flag) => {
      const created = await f.create("hidden-delta");
      await git(created.path, "update-index", flag, "README.md");
      await fs.writeFile(path.join(created.path, "README.md"), Buffer.alloc(16 * 1024 ** 2, 8));
      availableBytes = 144 * 1024 ** 2;

      await expect(f.service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
        /disk space/i,
      );

      expect(getRegistryWorktree(f.env, created.id)?.removedAt).toBeUndefined();
      expect((await fs.stat(path.join(created.path, "README.md"))).size).toBe(16 * 1024 ** 2);
      expect(await git(f.repo, "branch", "--list", "--format=%(refname)", created.branch)).toBe(
        `refs/heads/${created.branch}`,
      );
    },
  );

  it("rejects reuse of a broken Git link without destroying its work", async () => {
    const params = {
      repoRoot: f.repo,
      name: "broken-link",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:broken",
    };
    const created = await f.service.create(params);
    await writeFile(created.path, "uncommitted.txt", "only copy\n");
    const marker = await fs.readFile(path.join(created.path, ".git"), "utf8");
    await fs.rm(marker.trim().slice("gitdir: ".length), { recursive: true });
    await expect(f.service.create(params)).rejects.toThrow(
      /Git metadata.*preserved|preserved.*Git metadata/i,
    );
    expect(getRegistryWorktree(f.env, created.id)?.removedAt).toBeUndefined();
    await expectFile(created.path, "uncommitted.txt", "only copy\n");
  });
});

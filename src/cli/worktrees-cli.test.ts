import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeGcResult } from "../agents/worktrees/types.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";
import { registerWorktreesCli } from "./worktrees-cli.js";

const completedGc: ManagedWorktreeGcResult = {
  removed: [],
  orphansDeleted: 0,
  snapshotsPruned: 0,
  outcome: "completed",
  issues: [],
  protectedCount: 0,
  limitsSatisfied: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  resetConfigRuntimeState();
});

describe("worktrees cli", () => {
  it.each([false, true])(
    "reports the existing lossless owner outcome, removed=%s",
    async (removed) => {
      const cleanup = { outcome: removed ? "removed-lossless" : "retained-dirty", at: 1 } as const;
      const remove = vi.spyOn(managedWorktrees, "remove");
      vi.spyOn(managedWorktrees, "removeIfLossless").mockResolvedValue(removed);
      vi.spyOn(managedWorktrees, "listRegistryRecords").mockReturnValue([
        {
          id: "worktree-id",
          name: "task",
          repoFingerprint: "0123456789abcdef",
          repoRoot: "/repo",
          path: "/state/worktrees/task",
          branch: "openclaw/task",
          baseRef: "HEAD",
          ownerKind: "manual",
          createdAt: 1,
          lastActiveAt: 1,
          runEndCleanup: cleanup,
        },
      ]);
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
      const program = new Command().name("openclaw");
      registerWorktreesCli(program);
      await program.parseAsync(["worktrees", "remove", "worktree-id", "--if-lossless", "--json"], {
        from: "user",
      });
      expect(output).toHaveBeenCalledWith({ removed, cleanup });
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it("rejects conflicting removal policies before calling the owner", async () => {
    const remove = vi.spyOn(managedWorktrees, "remove");
    const lossless = vi.spyOn(managedWorktrees, "removeIfLossless");
    const program = new Command()
      .name("openclaw")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    registerWorktreesCli(program);
    await expect(
      program.parseAsync(["worktrees", "remove", "worktree-id", "--if-lossless", "--force"], {
        from: "user",
      }),
    ).rejects.toThrow("cannot be used with option");
    expect(remove).not.toHaveBeenCalled();
    expect(lossless).not.toHaveBeenCalled();
  });

  it("maps --force only to snapshot-loss permission", async () => {
    const remove = vi.spyOn(managedWorktrees, "remove").mockResolvedValue({ removed: true });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const program = new Command().name("openclaw");
    registerWorktreesCli(program);

    await program.parseAsync(["worktrees", "remove", "worktree-id", "--force"], {
      from: "user",
    });

    expect(remove).toHaveBeenCalledWith({
      id: "worktree-id",
      reason: "manual-delete",
      allowSnapshotLoss: true,
    });
  });

  it("passes session owner activity and built-in limits to gc", async () => {
    setRuntimeConfigSnapshot({}, {});
    const gc = vi.spyOn(managedWorktrees, "gc").mockResolvedValue(completedGc);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const program = new Command().name("openclaw");
    registerWorktreesCli(program);

    await program.parseAsync(["worktrees", "gc"], { from: "user" });

    expect(gc).toHaveBeenCalledWith({
      limits: { maxCount: 100 },
      shouldProtectOwner: expect.any(Function),
      shouldRemoveOwner: expect.any(Function),
    });
  });

  it.each([false, true])("prints partial progress before exiting 1 (json=%s)", async (json) => {
    setRuntimeConfigSnapshot({}, {});
    const result: ManagedWorktreeGcResult = {
      ...completedGc,
      removed: ["removed-id"],
      orphansDeleted: 2,
      snapshotsPruned: 3,
      outcome: "partial",
      issues: [{ stage: "idle", outcome: "failed", count: 4 }],
      limitsSatisfied: null,
    };
    vi.spyOn(managedWorktrees, "gc").mockResolvedValue(result);
    const output: unknown[] = [];
    let stdout = "";
    let releaseStdout: (() => void) | undefined;
    if (json) {
      // Hold the real finalizer's drain callback. A direct process exit would
      // discard this JSON while a piped stdout write is still pending.
      vi.spyOn(process.stdout, "write").mockImplementation((...args) => {
        stdout += String(args[0]);
        const callback = args.at(-1);
        if (typeof callback === "function") {
          releaseStdout = () => callback();
        }
        return true;
      });
    }
    vi.spyOn(defaultRuntime, "log").mockImplementation((value) => output.push(value));
    const exited = createDeferred();
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      output.push(code);
      exited.resolve();
    });
    const onError = vi.fn();
    const program = new Command().name("openclaw");
    registerWorktreesCli(program);

    await runCliWithExitFinalization({
      run: async () => {
        await program.parseAsync(["worktrees", "gc", ...(json ? ["--json"] : [])], {
          from: "user",
        });
      },
      onError,
      env: {},
      execArgv: [],
      platform: "linux",
      markers: {},
    });
    if (json) {
      expect(JSON.parse(stdout)).toEqual(result);
      expect(exit).not.toHaveBeenCalled();
      expect(releaseStdout).toBeTypeOf("function");
      releaseStdout?.();
    }
    await withTestTimeout(exited.promise, 1_000, "partial GC did not exit");

    expect(onError).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(output).toEqual(
      json
        ? [1]
        : [
            "Cleanup partial: worktrees removed: 1; orphans deleted: 2; snapshots pruned: 3; protected 0; limits unknown. idle failed=4.",
            1,
          ],
    );
  });

  it.each(["completed", "deferred"] as const)(
    "keeps %s cleanup successful and visible",
    async (outcome) => {
      setRuntimeConfigSnapshot({}, {});
      const result: ManagedWorktreeGcResult = {
        ...completedGc,
        outcome,
        protectedCount: 1,
        limitsSatisfied: false,
        issues: outcome === "deferred" ? [{ stage: "limits", outcome: "deferred", count: 1 }] : [],
      };
      vi.spyOn(managedWorktrees, "gc").mockResolvedValue(result);
      const output = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
      const program = new Command().name("openclaw");
      registerWorktreesCli(program);

      await program.parseAsync(["worktrees", "gc"], { from: "user" });

      expect(exit).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledWith(expect.stringContaining(`Cleanup ${outcome}:`));
      expect(output).toHaveBeenCalledWith(expect.stringContaining("protected 1; limits exceeded"));
    },
  );
});

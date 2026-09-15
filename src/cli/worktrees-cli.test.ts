import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { registerWorktreesCli } from "./worktrees-cli.js";

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
    const gc = vi.spyOn(managedWorktrees, "gc").mockResolvedValue({
      removed: [],
      orphansDeleted: 0,
      snapshotsPruned: 0,
    });
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
});

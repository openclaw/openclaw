import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { parseCliProfileArgs } from "./profile.js";
import { registerWorktreesCli } from "./worktrees-cli.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetConfigRuntimeState();
});

describe("worktrees cli", () => {
  it.each([
    { runtime: [], selected: [], profiles: undefined, state: null },
    { runtime: [], selected: ["--source-profile", "alpha"], profiles: ["alpha"], state: null },
    {
      runtime: ["--profile", "work"],
      selected: ["--source-profile", "alpha", "--source-profile=beta"],
      profiles: ["alpha", "beta"],
      state: "work",
    },
    { runtime: ["--dev"], selected: ["--source-profile=alpha"], profiles: ["alpha"], state: "dev" },
    {
      runtime: [],
      selected: ["--source-profile=alpha", "--profile", "work"],
      profiles: ["alpha"],
      state: "work",
    },
  ])(
    "passes source profiles through early parsing without changing runtime state: $state $selected",
    async ({ runtime, selected, profiles, state }) => {
      const create = vi.spyOn(managedWorktrees, "create").mockResolvedValue({
        id: "created",
        name: "task",
        repoFingerprint: "fingerprint",
        repoRoot: "/repo",
        path: "/state/task",
        branch: "openclaw/task",
        baseRef: "HEAD",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
      });
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
      const parsed = parseCliProfileArgs([
        "node",
        "openclaw",
        ...runtime,
        "worktrees",
        "create",
        "/repo",
        "--name",
        "task",
        "--json",
        ...selected,
      ]);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      expect(parsed.profile).toBe(state);
      const program = new Command().name("openclaw").exitOverride();
      registerWorktreesCli(program);
      await program.parseAsync(parsed.argv);
      expect(create).toHaveBeenCalledWith({
        repoRoot: "/repo",
        name: "task",
        baseRef: undefined,
        ownerKind: "manual",
        ...(profiles ? { profiles } : {}),
      });
    },
  );

  it("leaves missing source profile values to Commander and performs no creation", async () => {
    const create = vi.spyOn(managedWorktrees, "create");
    const parsed = parseCliProfileArgs([
      "node",
      "openclaw",
      "worktrees",
      "create",
      "/repo",
      "--source-profile",
    ]);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const program = new Command()
      .name("openclaw")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    registerWorktreesCli(program);
    await expect(program.parseAsync(parsed.argv)).rejects.toThrow(/argument missing/);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["create", "list", "remove", "restore", "gc"])(
    "preserves late runtime --profile on worktrees %s",
    (command) => {
      const parsed = parseCliProfileArgs([
        "node",
        "openclaw",
        "worktrees",
        command,
        "--profile",
        "work",
      ]);
      expect(parsed).toEqual({
        ok: true,
        profile: "work",
        argv: ["node", "openclaw", "worktrees", command],
      });
    },
  );

  it.each([false, true])(
    "reports the existing lossless owner outcome, removed=%s",
    async (removed) => {
      const cleanup = { outcome: removed ? "removed-lossless" : "retained-dirty", at: 1 } as const;
      const remove = vi.spyOn(managedWorktrees, "remove");
      vi.spyOn(managedWorktrees, "removeIfLossless").mockResolvedValue(removed);
      vi.spyOn(managedWorktrees, "listRegistryRecords").mockResolvedValue([
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
      outcome: "completed",
      issues: [],
      issueCount: 0,
      protectedCount: 0,
      limitsSatisfied: true,
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

  it("prints partial cleanup details before returning failure", async () => {
    setRuntimeConfigSnapshot({}, {});
    const result = {
      removed: ["removed"],
      orphansDeleted: 0,
      snapshotsPruned: 0,
      outcome: "partial" as const,
      issues: [
        {
          id: "retained",
          stage: "idle" as const,
          outcome: "failed" as const,
          reason: "cleanup-failed: repository unavailable",
        },
      ],
      issueCount: 1,
      protectedCount: 0,
      limitsSatisfied: false,
    };
    vi.spyOn(managedWorktrees, "gc").mockResolvedValue(result);
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const program = new Command().name("openclaw");
    registerWorktreesCli(program);

    await expect(
      program.parseAsync(["worktrees", "gc", "--json"], { from: "user" }),
    ).rejects.toThrow();
    expect(output).toHaveBeenCalledWith(result);
  });
});

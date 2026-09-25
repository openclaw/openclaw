import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const exactRequest = {
    ownerKind: "session",
    ownerId: "example-owner",
    createdAt: 1,
    lastActiveAt: 2,
    head: "1".repeat(40),
    branchHead: "2".repeat(40),
    indexSha256: "a".repeat(64),
  };
  it("passes a validated exact-state request through the removal CLI", async () => {
    const filename = path.join(tempDirs.make("openclaw-exact-cli-"), "request.json");
    await fs.writeFile(filename, JSON.stringify(exactRequest));
    const remove = vi.spyOn(managedWorktrees, "remove").mockResolvedValue({ removed: true });
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const program = new Command().name("openclaw");
    registerWorktreesCli(program);
    await program.parseAsync(
      ["worktrees", "remove", "worktree-id", "--exact-state", filename, "--json"],
      { from: "user" },
    );
    expect(remove).toHaveBeenCalledWith({
      id: "worktree-id",
      reason: "manual-delete",
      allowSnapshotLoss: false,
      exactState: exactRequest,
    });
  });
  it.each(["--force", "--if-lossless"])(
    "rejects exact-state retirement with %s before reading its request",
    async (conflict) => {
      const remove = vi.spyOn(managedWorktrees, "remove");
      const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
      registerWorktreesCli(program);
      await expect(
        program.parseAsync(
          ["worktrees", "remove", "worktree-id", "--exact-state", "/missing-request", conflict],
          { from: "user" },
        ),
      ).rejects.toThrow(/cannot be used with/);
      expect(remove).not.toHaveBeenCalled();
    },
  );

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

  it("requires an exact pending commit and returns recovery's actual outcome", async () => {
    const snapshot = "a".repeat(40);
    const recover = vi.spyOn(managedWorktrees, "recoverRemoval").mockResolvedValue({
      removed: true,
      snapshotRef: "refs/openclaw/snapshots/worktree-id",
    });
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerWorktreesCli(program);
    await expect(
      program.parseAsync(["worktrees", "recover-removal", "worktree-id"], { from: "user" }),
    ).rejects.toThrow(/required option/);
    expect(recover).not.toHaveBeenCalled();
    await program.parseAsync(
      ["worktrees", "recover-removal", "worktree-id", "--snapshot", snapshot, "--json"],
      { from: "user" },
    );
    expect(recover).toHaveBeenCalledWith({ id: "worktree-id", snapshot });
    expect(output).toHaveBeenCalledWith({
      removed: true,
      snapshotRef: "refs/openclaw/snapshots/worktree-id",
    });
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
      protectionReasons: {},
      orphansRetired: 0,
      retiredCheckoutPaths: [],
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
      protectionReasons: {},
      orphansRetired: 0,
      retiredCheckoutPaths: [],
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

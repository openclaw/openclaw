import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
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
    const remove = vi
      .spyOn(ManagedWorktreeService.prototype, "remove")
      .mockResolvedValue({ removed: true });
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
      signal: expect.any(AbortSignal),
      commitGuard: expect.any(Function),
      allowSnapshotLoss: false,
      exactState: exactRequest,
    });
  });
  it.each(["--force", "--if-lossless"])(
    "rejects exact-state retirement with %s before reading its request",
    async (conflict) => {
      const remove = vi.spyOn(ManagedWorktreeService.prototype, "remove");
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
      const repoRoot = await fs.realpath(tempDirs.make("openclaw-cli-profile-input-"));
      const create = vi.spyOn(ManagedWorktreeService.prototype, "create").mockResolvedValue({
        id: "created",
        name: "task",
        repoFingerprint: "fingerprint",
        repoRoot,
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
        repoRoot,
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
        repoRoot,
        name: "task",
        baseRef: undefined,
        ownerKind: "manual",
        signal: expect.any(AbortSignal),
        commitGuard: expect.any(Function),
        ...(profiles ? { profiles } : {}),
      });
    },
  );

  it("leaves missing source profile values to Commander and performs no creation", async () => {
    const create = vi.spyOn(ManagedWorktreeService.prototype, "create");
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

  it("rejects conflicting removal policies before calling the owner", async () => {
    const remove = vi.spyOn(ManagedWorktreeService.prototype, "remove");
    const lossless = vi.spyOn(ManagedWorktreeService.prototype, "removeIfLossless");
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
    const recover = vi.spyOn(ManagedWorktreeService.prototype, "recoverRemoval").mockResolvedValue({
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
    expect(recover).toHaveBeenCalledWith({
      id: "worktree-id",
      snapshot,
      signal: expect.any(AbortSignal),
      commitGuard: expect.any(Function),
    });
    expect(output).toHaveBeenCalledWith({
      removed: true,
      snapshotRef: "refs/openclaw/snapshots/worktree-id",
    });
  });

  it("maps --force only to snapshot-loss permission", async () => {
    const remove = vi
      .spyOn(ManagedWorktreeService.prototype, "remove")
      .mockResolvedValue({ removed: true });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const program = new Command().name("openclaw");
    registerWorktreesCli(program);

    await program.parseAsync(["worktrees", "remove", "worktree-id", "--force"], {
      from: "user",
    });

    expect(remove).toHaveBeenCalledWith({
      id: "worktree-id",
      reason: "manual-delete",
      signal: expect.any(AbortSignal),
      commitGuard: expect.any(Function),
      allowSnapshotLoss: true,
    });
  });

  it("passes session owner activity and built-in limits to gc", async () => {
    setRuntimeConfigSnapshot({}, {});
    const gc = vi.spyOn(ManagedWorktreeService.prototype, "gc").mockResolvedValue({
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
      signal: expect.any(AbortSignal),
      commitGuard: expect.any(Function),
      retryDeferred: true,
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
    vi.spyOn(ManagedWorktreeService.prototype, "gc").mockResolvedValue(result);
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const program = new Command().name("openclaw");
    registerWorktreesCli(program);

    await expect(
      program.parseAsync(["worktrees", "gc", "--json"], { from: "user" }),
    ).rejects.toThrow();
    expect(output).toHaveBeenCalledWith(result);
  });
});

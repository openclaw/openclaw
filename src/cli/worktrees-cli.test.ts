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

function createProgram() {
  const program = new Command().name("openclaw").exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerWorktreesCli(program);
  return program;
}

const run = (args: string[]) =>
  createProgram().parseAsync(["worktrees", ...args], { from: "user" });
const admission = { signal: expect.any(AbortSignal), commitGuard: expect.any(Function) };
const owner = ManagedWorktreeService.prototype;
const muteOutput = (json = true) =>
  vi.spyOn(defaultRuntime, json ? "writeJson" : "log").mockImplementation(() => undefined);

function parseProfile(args: string[]) {
  const parsed = parseCliProfileArgs(["node", "openclaw", ...args]);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed;
}

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
  it.each(["exact-state", "force"] as const)(
    "passes the %s removal policy to the owner",
    async (policy) => {
      const exact = policy === "exact-state";
      const filename = path.join(tempDirs.make("openclaw-exact-cli-"), "request.json");
      if (exact) {
        await fs.writeFile(filename, JSON.stringify(exactRequest));
      }
      const remove = vi.spyOn(owner, "remove").mockResolvedValue({ removed: true });
      muteOutput(exact);
      await run([
        "remove",
        "worktree-id",
        ...(exact ? ["--exact-state", filename, "--json"] : ["--force"]),
      ]);
      expect(remove).toHaveBeenCalledWith({
        id: "worktree-id",
        reason: "manual-delete",
        ...admission,
        allowSnapshotLoss: !exact,
        ...(exact ? { exactState: exactRequest } : {}),
      });
    },
  );
  it.each([
    ["--exact-state", "/missing-request", "--force"],
    ["--exact-state", "/missing-request", "--if-lossless"],
    ["--if-lossless", "--force"],
  ])("rejects conflicting removal policies %j before reading or mutating", async (...flags) => {
    const remove = vi.spyOn(owner, "remove");
    const lossless = vi.spyOn(owner, "removeIfLossless");
    await expect(run(["remove", "worktree-id", ...flags])).rejects.toThrow(
      "cannot be used with option",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(lossless).not.toHaveBeenCalled();
  });

  it.each([
    [[], [], undefined, null],
    [[], ["--source-profile", "alpha"], ["alpha"], null],
    [
      ["--profile", "work"],
      ["--source-profile", "alpha", "--source-profile=beta"],
      ["alpha", "beta"],
      "work",
    ],
    [["--dev"], ["--source-profile=alpha"], ["alpha"], "dev"],
    [[], ["--source-profile=alpha", "--profile", "work"], ["alpha"], "work"],
  ] satisfies [string[], string[], string[] | undefined, string | null][])(
    "passes source profiles through early parsing: %j %j",
    async (runtime, selected, profiles, state) => {
      const repoRoot = await fs.realpath(tempDirs.make("openclaw-cli-profile-input-"));
      const create = vi.spyOn(owner, "create").mockResolvedValue({
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
      muteOutput();
      const parsed = parseProfile([
        ...runtime,
        "worktrees",
        "create",
        repoRoot,
        "--name",
        "task",
        "--json",
        ...selected,
      ]);
      expect(parsed.profile).toBe(state);
      await createProgram().parseAsync(parsed.argv);
      expect(create).toHaveBeenCalledWith({
        repoRoot,
        name: "task",
        baseRef: undefined,
        ownerKind: "manual",
        ...admission,
        ...(profiles ? { profiles } : {}),
      });
    },
  );

  it("leaves missing source profile values to Commander and performs no creation", async () => {
    const create = vi.spyOn(owner, "create");
    const parsed = parseProfile(["worktrees", "create", "/repo", "--source-profile"]);
    await expect(createProgram().parseAsync(parsed.argv)).rejects.toThrow(/argument missing/);
    expect(create).not.toHaveBeenCalled();
  });

  it("requires an exact pending commit and returns recovery's actual outcome", async () => {
    const snapshot = "a".repeat(40);
    const recover = vi.spyOn(owner, "recoverRemoval").mockResolvedValue({
      removed: true,
      snapshotRef: "refs/openclaw/snapshots/worktree-id",
    });
    const output = muteOutput();
    const program = createProgram();
    const recoverArgs = ["worktrees", "recover-removal", "worktree-id"];
    await expect(program.parseAsync(recoverArgs, { from: "user" })).rejects.toThrow(
      /required option/,
    );
    expect(recover).not.toHaveBeenCalled();
    await program.parseAsync([...recoverArgs, "--snapshot", snapshot, "--json"], { from: "user" });
    expect(recover).toHaveBeenCalledWith({
      id: "worktree-id",
      snapshot,
      ...admission,
    });
    expect(output).toHaveBeenCalledWith({
      removed: true,
      snapshotRef: "refs/openclaw/snapshots/worktree-id",
    });
  });

  it.each([false, true])("reports cleanup and signals partial failure: %s", async (partial) => {
    setRuntimeConfigSnapshot({}, {});
    const result = {
      removed: partial ? ["removed"] : [],
      orphansDeleted: 0,
      snapshotsPruned: 0,
      outcome: partial ? ("partial" as const) : ("completed" as const),
      issues: partial
        ? [
            {
              id: "retained",
              stage: "idle" as const,
              outcome: "failed" as const,
              reason: "cleanup-failed: repository unavailable",
            },
          ]
        : [],
      issueCount: partial ? 1 : 0,
      eligibleCount: partial ? 2 : 0,
      deferredCount: 0,
      failedCount: partial ? 1 : 0,
      protectedCount: 0,
      protectionReasons: {},
      orphansRetired: 0,
      retiredCheckoutPaths: [],
      limitsSatisfied: !partial,
    };
    const gc = vi.spyOn(owner, "gc").mockResolvedValue(result);
    const output = muteOutput(partial);
    const pending = run(["gc", ...(partial ? ["--json", "--retry-deferred"] : [])]);
    if (partial) {
      await expect(pending).rejects.toThrow();
      expect(output).toHaveBeenCalledWith(result);
    } else {
      await pending;
      expect(output).toHaveBeenCalledWith(expect.stringContaining("cleanup completed: removed 0"));
    }
    expect(gc).toHaveBeenCalledWith(
      expect.objectContaining({
        ...admission,
        retryDeferred: partial,
        readOwnerState: expect.any(Function),
      }),
    );
  });
});

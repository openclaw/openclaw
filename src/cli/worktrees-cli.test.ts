import fs from "node:fs/promises";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { makeWorktreeRecord } from "../agents/worktrees/service.test-support.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliFailureLines } from "./failure-output.js";
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

describe("worktrees cli", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["list", "create"] as const)(
    "escapes %s output but preserves raw JSON",
    async (command) => {
      const repoRoot = await fs.realpath(tempDirs.make("openclaw-terminal-worktree-"));
      const record = makeWorktreeRecord(
        command === "list" ? "/repo/café\x1b[31m\nforged" : repoRoot,
        "worktree-id",
        {
          path: "/state/café\x1b[31m\nforged\tpath\r\x00\x85",
        },
      );
      if (command === "list") {
        vi.spyOn(owner, "list").mockResolvedValue([record]);
      } else {
        vi.spyOn(owner, "create").mockResolvedValue(record);
      }
      const args = command === "list" ? [command] : [command, repoRoot];
      const text = muteOutput(false);
      await run(args);
      if (command === "list") {
        const output = text.mock.calls.map(([line]) => String(line)).join("\n");
        expect(output).toContain("/repo/café\\nforged");
        expect(output).toContain(record.branch);
        expect(output.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
      } else {
        expect(text).toHaveBeenCalledWith("worktree-id\t/state/café\\nforged\\tpath\\r");
      }
      const json = muteOutput();
      await run([...args, "--json"]);
      expect(json).toHaveBeenCalledWith(command === "list" ? { worktrees: [record] } : record);
    },
  );
  it("passes explicit force permission to the removal owner", async () => {
    const remove = vi.spyOn(owner, "remove").mockResolvedValue({ removed: true });
    muteOutput(false);
    await run(["remove", "worktree-id", "--force"]);
    expect(remove).toHaveBeenCalledWith({
      id: "worktree-id",
      reason: "manual-delete",
      ...admission,
      allowSnapshotLoss: true,
    });
  });
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

  it("leaves missing source profile values to Commander and performs no creation", async () => {
    const create = vi.spyOn(owner, "create");
    await expect(run(["create", "/repo", "--source-profile"])).rejects.toThrow(/argument missing/);
    expect(create).not.toHaveBeenCalled();
  });

  it("requires an exact pending commit and returns recovery's actual outcome", async () => {
    const snapshot = "a".repeat(40);
    const result: Awaited<ReturnType<ManagedWorktreeService["recoverRemoval"]>> = {
      removed: true,
      snapshotRef: "refs/openclaw/snapshots/worktree-id",
    };
    const recover = vi.spyOn(owner, "recoverRemoval").mockResolvedValue(result);
    const output = muteOutput();
    const recoverArgs = ["recover-removal", "worktree-id"];
    await expect(run(recoverArgs)).rejects.toThrow(/required option/);
    expect(recover).not.toHaveBeenCalled();
    await run([...recoverArgs, "--snapshot", snapshot, "--json"]);
    expect(recover).toHaveBeenCalledWith({ id: "worktree-id", snapshot, ...admission });
    expect(output).toHaveBeenCalledWith(result);
  });

  const retireSnapshotArgs = (removedAt: string) => [
    "retire-snapshot",
    "worktree-id",
    "--expected-ref",
    "refs/openclaw/snapshots/worktree-id",
    "--expected-oid",
    "a".repeat(40),
    "--removed-at",
    removedAt,
    "--retained-ref",
    "refs/heads/main",
    "--retained-oid",
    "b".repeat(40),
  ];

  it.each(["1700000000100ms", "-1", "", "9007199254740993"])(
    "rejects the malformed --removed-at value %j before retiring a snapshot",
    async (removedAt) => {
      setRuntimeConfigSnapshot({}, {});
      const retire = vi
        .spyOn(owner, "retireSnapshot")
        .mockRejectedValue(new Error("Unexpected snapshot retirement"));
      const pending = run(retireSnapshotArgs(removedAt));
      await expect(pending).rejects.toThrow(
        "--removed-at must be a non-negative integer (epoch milliseconds).",
      );
      expect(retire).not.toHaveBeenCalled();
      expect(
        formatCliFailureLines({
          title: "The CLI command failed.",
          error: await pending.catch((cause: unknown) => cause),
          argv: ["node", "openclaw", "worktrees", "retire-snapshot"],
          env: {},
        }),
      ).toEqual([
        `--removed-at must be a non-negative integer (epoch milliseconds). Got: ${JSON.stringify(removedAt)}`,
      ]);
    },
  );

  it("rejects an empty cleanup job selector before cleanup", async () => {
    setRuntimeConfigSnapshot({}, {});
    const gc = vi.spyOn(owner, "gc").mockRejectedValue(new Error("Unexpected cleanup execution"));
    await expect(run(["gc", "--job", "", "--json"])).rejects.toThrow("--job must not be empty");
    expect(gc).not.toHaveBeenCalled();
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

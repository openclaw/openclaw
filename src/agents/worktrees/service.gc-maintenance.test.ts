import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as registryReads from "./registry-read.js";
import { getRegistryWorktree, insertRegistryWorktree } from "./registry.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const initializeRepository = useManagedWorktreeTestRepository();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("maintains each live repository after removals and warns without changing the cleanup outcome", async () => {
  const root = tempDirs.make("worktree-gc-maintenance-");
  const repo = await initializeRepository(path.join(root, "first"));
  const otherRepo = await initializeRepository(path.join(root, "second"));
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const now = IDLE_GC_MS + 2;
  await materializeManagedWorktreeFixtures({
    env,
    stateDir,
    repoRoot: repo,
    now: 1,
    names: ["manual-one", "manual-two"],
  });
  await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot: otherRepo,
    now: 1,
    name: "other-manual",
  });
  const idle = await materializeManagedWorktreeFixture({
    env,
    stateDir,
    repoRoot: repo,
    now: 1,
    name: "idle",
    ownerKind: "session",
  });
  const service = new ManagedWorktreeService({ env, now: () => now });
  const controller = new AbortController();
  const execute = gitExec.executeGitCommand;
  const maintenanceRoots: string[] = [];
  const commands = vi
    .spyOn(gitExec, "executeGitCommand")
    .mockImplementation(async (cwd, args, options) => {
      if (args[0] !== "maintenance") {
        return await execute(cwd, args, options);
      }
      expect(getRegistryWorktree(env, idle.id)?.removedAt).toBe(now);
      expect(args).toEqual(["maintenance", "run", "--auto"]);
      expect(options).toMatchObject({
        killProcessTree: true,
        signal: controller.signal,
        timeoutMs: 30 * 60_000,
        beforeRun: expect.any(Function),
      });
      options?.beforeRun?.();
      maintenanceRoots.push(cwd);
      return {
        stdout: "",
        stderr: cwd === repo ? "gc is already running" : "",
        code: cwd === repo ? 1 : 0,
        signal: null,
        killed: false,
        termination: "exit",
        timeoutMs: options?.timeoutMs ?? 120_000,
      };
    });
  const logs = createWarnLogCapture("worktree-gc-maintenance");
  try {
    const result = await service.gc({ signal: controller.signal });
    expect(result).toMatchObject({
      removed: [idle.id],
      outcome: "completed",
      issues: [],
      issueCount: 0,
    });
    expect(maintenanceRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
    const warning = await logs.findText("worktree Git maintenance failed");
    expect(warning).toContain("gc is already running");
    const calls = commands.mock.calls.length;
    controller.abort(new Error("cleanup cancelled"));
    await expect(service.gc({ signal: controller.signal })).rejects.toThrow("cleanup cancelled");
    expect(commands).toHaveBeenCalledTimes(calls);
  } finally {
    logs.cleanup();
  }
});

it("warns without changing completed cleanup when the maintenance inventory fails", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-gc-inventory-") };
  vi.spyOn(registryReads, "readRegistryWorktrees").mockRejectedValueOnce(
    new Error("maintenance inventory unavailable"),
  );
  const logs = createWarnLogCapture("worktree-gc-inventory");
  try {
    const result = await new ManagedWorktreeService({ env }).gc({ limits: {} });
    expect(result).toMatchObject({ removed: [], outcome: "completed", issues: [], issueCount: 0 });
    expect(await logs.findText("worktree Git maintenance inventory failed")).toContain(
      "maintenance inventory unavailable",
    );
  } finally {
    logs.cleanup();
  }
});

it.each([false, true])(
  "skips maintenance without live records (removed record: %s)",
  async (removedRecord) => {
    const root = tempDirs.make("worktree-gc-no-maintenance-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    if (removedRecord) {
      insertRegistryWorktree(env, {
        id: "removed",
        name: "removed",
        repoFingerprint: "fixture",
        repoRoot: root,
        path: path.join(root, "removed"),
        branch: "openclaw/removed",
        baseRef: "HEAD",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
        removedAt: 2,
      });
    }
    const commands = vi.spyOn(gitExec, "executeGitCommand");
    expect((await new ManagedWorktreeService({ env, now: () => 3 }).gc()).outcome).toBe(
      "completed",
    );
    expect(commands.mock.calls.filter(([, args]) => args[0] === "maintenance")).toEqual([]);
  },
);

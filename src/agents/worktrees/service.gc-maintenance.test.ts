import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as registryReads from "./registry-read.js";
import {
  deleteRegistryWorktree,
  insertRegistryWorktree,
  listRegistryWorktrees,
} from "./registry.js";
import { ManagedWorktreeService } from "./service.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-gc-maintenance-state-") };

beforeAll(async () => {
  await registryReads.readRegistryWorktrees(env);
  await registryReads.readWorktreeCleanupState(env);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const record of listRegistryWorktrees(env)) {
    deleteRegistryWorktree(env, record.id);
  }
});

it("maintains each live repository and warns without changing the cleanup outcome", async () => {
  const repo = tempDirs.make("worktree-gc-first-repo-");
  const otherRepo = tempDirs.make("worktree-gc-second-repo-");
  for (const [index, repoRoot] of [repo, otherRepo].entries()) {
    const name = `manual-${index}`;
    insertRegistryWorktree(env, {
      id: name,
      name,
      repoFingerprint: name,
      repoRoot,
      path: repoRoot,
      branch: `openclaw/${name}`,
      baseRef: "HEAD",
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 1,
    });
  }
  const service = new ManagedWorktreeService({ env, now: () => 3 });
  const controller = new AbortController();
  const execute = gitExec.executeGitCommand;
  const maintenanceRoots: string[] = [];
  const commands = vi
    .spyOn(gitExec, "executeGitCommand")
    .mockImplementation(async (cwd, args, options) => {
      if (args[0] !== "maintenance") {
        return await execute(cwd, args, options);
      }
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
      removed: [],
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

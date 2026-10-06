import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorktreeRecordSchema,
  WorktreesGcResultSchema,
  WorktreesListResultSchema,
} from "../../../packages/gateway-protocol/src/schema/worktrees.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { WorktreeGcProgress } from "../../agents/worktrees/gc-progress.js";
import { WorktreeSnapshotError } from "../../agents/worktrees/service.js";
import type {
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
} from "../../agents/worktrees/types.js";
import { registerProjectRegistry, removeProjectRegistry } from "../../projects/project-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { startWorktreeMaintenance } from "../worktree-maintenance.js";
import * as localStateOwner from "./local-state-owner.js";
import { createWorktreesHandlers } from "./worktrees.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

async function initializeRepository(root: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await fs.writeFile(path.join(repo, "README.md"), `${name}\n`);
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  return await fs.realpath(repo);
}

const record: ManagedWorktreeRecord = {
  id: "worktree-id",
  name: "task-one",
  repoFingerprint: "0123456789abcdef",
  repoRoot: "/repo",
  path: "/state/worktrees/0123456789abcdef/task-one",
  branch: "openclaw/task-one",
  baseRef: "HEAD",
  ownerKind: "manual",
  createdAt: 1,
  lastActiveAt: 2,
};

async function call(
  handlers: ReturnType<typeof createWorktreesHandlers>,
  method: keyof ReturnType<typeof createWorktreesHandlers>,
  params: Record<string, unknown>,
  extras: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await handlers[method]?.({ params, respond, ...extras } as never);
  return respond.mock.calls[0];
}

const adminClient = { connect: { scopes: ["operator.admin"] } };
const writeClient = { connect: { scopes: ["operator.write"] } };
const emptyConfigContext = { getRuntimeConfig: () => ({}) };

describe("worktrees gateway methods", () => {
  it("routes checkout operations through the managed worktree service", async () => {
    const deferred: ManagedWorktreeRecord = {
      ...record,
      gcProtection: "branch-moved",
      gcRetry: { stage: "snapshot", elapsedMs: 120_000, attempts: 1, retryAt: 7_200_000 },
    };
    const service = {
      list: vi.fn(async () => [deferred]),
      create: vi.fn(async () => deferred),
      remove: vi.fn(async () => ({ removed: true, snapshotRef: "refs/snapshot" })),
      restore: vi.fn(async () => ({ ...deferred, snapshotRef: "refs/snapshot" })),
    };
    const handlers = createWorktreesHandlers(service as never);

    const listed = await call(handlers, "worktrees.list", {});
    expect(listed).toEqual([true, { worktrees: [record] }, undefined]);
    expect(
      await call(
        handlers,
        "worktrees.create",
        {
          repoRoot: "/repo",
          name: "task-one",
          baseRef: "main",
        },
        { client: adminClient, context: emptyConfigContext },
      ),
    ).toEqual([true, record, undefined]);
    expect(await call(handlers, "worktrees.remove", { id: record.id, force: true })).toEqual([
      true,
      { removed: true, snapshotRef: "refs/snapshot" },
      undefined,
    ]);
    const restoreResult = expectDefined(
      await call(handlers, "worktrees.restore", { id: record.id }),
      "worktree restore response",
    );
    expect(expectDefined(restoreResult[0], "worktree restore success flag")).toBe(true);
    expect(Value.Check(WorktreeRecordSchema, restoreResult[1])).toBe(true);
    expect(restoreResult[1]).toEqual({ ...record, snapshotRef: "refs/snapshot" });
    expect(Value.Check(WorktreesListResultSchema, listed?.[1])).toBe(true);
    // mock-isolation: Response projection consumes an already accepted local owner.
    const ownerGuard = vi
      .spyOn(localStateOwner, "captureLocalStateMutationGuard")
      .mockReturnValue(() => {});
    try {
      for (const [method, params] of [
        ["worktrees.create", { repoRoot: "/repo" }],
        ["worktrees.restore", { id: record.id }],
      ] as const) {
        const qualified = expectDefined(
          await call(
            handlers,
            method,
            { ...params, expectedOwnerId: "gateway-owner" },
            { client: adminClient, context: emptyConfigContext },
          ),
          "qualified worktree response",
        );
        expect(qualified[0]).toBe(true);
        expect(Value.Check(WorktreeRecordSchema, qualified[1])).toBe(true);
        expect(qualified[1]).toMatchObject({ gcProtection: "branch-moved" });
        expect(qualified[1]).not.toHaveProperty("gcRetry");
      }
    } finally {
      ownerGuard.mockRestore();
    }
    expect(service.create).toHaveBeenCalledWith({
      repoRoot: "/repo",
      name: "task-one",
      baseRef: "main",
      ownerKind: "manual",
      runSetupScript: true,
    });
    expect(service.remove).toHaveBeenCalledWith({
      id: record.id,
      reason: "manual-delete",
      allowSnapshotLoss: true,
    });
  });

  it("lists branches for admin clients and configured workspaces only", async () => {
    const service = {
      listRepositoryBranches: vi.fn(async () => ({
        branches: [{ name: "main", kind: "local" as const }],
        defaultBranch: "main",
      })),
    };
    const handlers = createWorktreesHandlers(service as never);

    const adminResponse = await call(
      handlers,
      "worktrees.branches",
      { repoRoot: "/anywhere" },
      { client: adminClient, context: emptyConfigContext },
    );
    expect(adminResponse?.[0]).toBe(true);
    expect(service.listRepositoryBranches).toHaveBeenCalledWith("/anywhere");

    const statusResponse = await call(
      handlers,
      "worktrees.branches",
      { repoRoot: "/anywhere", includeRepositoryStatus: true },
      { client: adminClient, context: emptyConfigContext },
    );
    expect(statusResponse?.[0]).toBe(true);
    expect(service.listRepositoryBranches).toHaveBeenCalledWith("/anywhere", {
      includeRepositoryStatus: true,
    });

    // Write scope cannot probe arbitrary host paths for branch names; the
    // denial uses the shared structured missing-scope contract so clients can
    // tell an authorization failure apart from a repository inspection failure.
    const denied = await call(
      handlers,
      "worktrees.branches",
      { repoRoot: "/anywhere" },
      { client: writeClient, context: emptyConfigContext },
    );
    expect(denied?.[0]).toBe(false);
    expect(denied?.[2]).toMatchObject({
      code: "FORBIDDEN",
      message: "missing scope: operator.admin",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.admin",
        requiredScopes: ["operator.admin"],
      },
    });
  });

  it("allows write-scoped branch listing for a subdirectory inside an agent workspace", async () => {
    const os = await import("node:os");
    const workspace = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-branches-scope-"),
    );
    const repoRoot = path.join(workspace, "packages", "app");
    await fs.mkdir(repoRoot, { recursive: true });
    try {
      const service = {
        listRepositoryBranches: vi.fn(async () => ({ branches: [] })),
      };
      const handlers = createWorktreesHandlers(service as never);
      const response = await call(
        handlers,
        "worktrees.branches",
        { repoRoot },
        {
          client: writeClient,
          context: {
            getRuntimeConfig: () => ({
              agents: { entries: { main: { workspace } } },
            }),
          },
        },
      );
      expect(response?.[0]).toBe(true);
      expect(service.listRepositoryBranches).toHaveBeenCalledWith(repoRoot);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("allows a write-scoped registered project root but still rejects other outside paths", async () => {
    const root = tempDirs.make("openclaw-branches-project-");
    const repoRoot = await initializeRepository(root, "registered");
    const alias = path.join(root, "registered-link");
    const outside = path.join(root, "outside");
    await fs.symlink(repoRoot, alias, "dir");
    await fs.mkdir(outside);
    const project = await registerProjectRegistry({ path: repoRoot, name: "Registered" });
    const service = {
      create: vi.fn(async () => record),
      listRepositoryBranches: vi.fn(async () => ({ branches: [] })),
    };
    const handlers = createWorktreesHandlers(service as never);
    try {
      const allowed = await call(
        handlers,
        "worktrees.branches",
        { repoRoot: alias },
        { client: writeClient, context: emptyConfigContext },
      );
      expect(allowed?.[0]).toBe(true);
      expect(service.listRepositoryBranches).toHaveBeenCalledWith(repoRoot);

      const created = await call(
        handlers,
        "worktrees.create",
        { repoRoot: alias, name: "registered-task" },
        { client: writeClient, context: emptyConfigContext },
      );
      expect(created?.[0]).toBe(true);
      expect(service.create).toHaveBeenCalledWith({
        repoRoot,
        name: "registered-task",
        baseRef: undefined,
        ownerKind: "manual",
        runSetupScript: false,
      });

      const denied = await call(
        handlers,
        "worktrees.branches",
        { repoRoot: outside },
        { client: writeClient, context: emptyConfigContext },
      );
      expect(denied?.[0]).toBe(false);
      expect(denied?.[2]).toMatchObject({
        code: "FORBIDDEN",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.admin",
          requiredScopes: ["operator.admin"],
        },
      });
    } finally {
      await removeProjectRegistry(project);
    }
  });

  it("returns a GC receipt immediately and exposes its completed outcome when polled", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const sweep = createDeferred<ManagedWorktreeGcResult>();
    const runGc = vi.fn(() => sweep.promise);
    const config = {};
    const context = { getRuntimeConfig: () => config };
    const maintenance = startWorktreeMaintenance({
      scheduler,
      getRuntimeConfig: context.getRuntimeConfig,
      runGc,
      onComplete: vi.fn(),
      onError: vi.fn(),
    });
    const handlers = createWorktreesHandlers({ gc: runGc } as never);
    const respond = vi.fn();
    let running: Promise<void> | void = undefined;
    const result: ManagedWorktreeGcResult = {
      ...new WorktreeGcProgress().result,
      removed: ["removed"],
      outcome: "partial",
      limitsSatisfied: false,
      issueCount: 1,
      eligibleCount: 2,
      failedCount: 1,
      issues: [
        { id: "retained", stage: "idle", outcome: "failed", reason: "repository unavailable" },
      ],
    };
    try {
      const request = handlers["worktrees.gc"]!({ params: {}, respond, context } as never);
      // The request replies before any cleanup can start or settle.
      expect(respond).toHaveBeenCalledOnce();
      expect(runGc).not.toHaveBeenCalled();
      await request;
      const receipt = respond.mock.calls[0]![1];
      expect(receipt).toMatchObject({
        state: "queued",
        jobId: expect.any(String),
        eligibleCount: 0,
        deferredCount: 0,
        failedCount: 0,
      });
      expect(Value.Check(WorktreesGcResultSchema, receipt)).toBe(true);

      running = clock.advanceBy(0);
      const pending = await call(handlers, "worktrees.gc", { jobId: receipt.jobId }, { context });
      expect(pending?.[1]).toMatchObject({ jobId: receipt.jobId, state: "running" });
      sweep.resolve(result);
      await running;
      const completed = await call(handlers, "worktrees.gc", { jobId: receipt.jobId }, { context });
      expect(completed).toEqual([
        true,
        expect.objectContaining({ ...result, jobId: receipt.jobId, state: "completed" }),
        undefined,
      ]);
      expect(Value.Check(WorktreesGcResultSchema, completed?.[1])).toBe(true);
    } finally {
      sweep.resolve(result);
      await running;
      await maintenance.stop();
      await scheduler.stop();
    }
  });

  it("maps snapshot failures onto a structured removed=false result", async () => {
    const service = {
      remove: vi.fn(async () => {
        throw new WorktreeSnapshotError("nested gitlink");
      }),
    };
    const handlers = createWorktreesHandlers(service as never);
    expect(await call(handlers, "worktrees.remove", { id: record.id })).toEqual([
      true,
      { removed: false, snapshotError: "nested gitlink" },
      undefined,
    ]);
  });

  it.each([
    ["worktrees.create", { repoRoot: "" }],
    ["worktrees.gc", { retryDeferred: "yes" }],
    ["worktrees.remove", { id: record.id, force: true, ifLossless: true }],
    ["worktrees.remove", { id: record.id, exactState: { head: "incomplete" } }],
    ["worktrees.restore", { id: record.id, recoverExactState: { head: "incomplete" } }],
    ["worktrees.recoverRemoval", { id: record.id, snapshot: "a".repeat(40) }],
    ["worktrees.retireSnapshot", { id: record.id }],
  ])("refuses invalid %s parameters before admitting a mutation", async (method, params) => {
    const handlers = createWorktreesHandlers({} as never);
    const response = await call(handlers, method, params);

    expect(response?.[0]).toBe(false);
    expect(response?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: { mutationAccepted: false },
    });
  });
});

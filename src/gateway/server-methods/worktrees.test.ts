import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import {
  WorktreeRecordSchema,
  WorktreesGcResultSchema,
  WorktreesListResultSchema,
} from "../../../packages/gateway-protocol/src/schema/worktrees.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { WorktreeGcProgress } from "../../agents/worktrees/gc-progress.js";
import { initializeGitFixture } from "../../agents/worktrees/git-fixture.test-support.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

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

const emptyConfigContext = { getRuntimeConfig: () => ({}) };
const admin = { client: { connect: { scopes: ["operator.admin"] } }, context: emptyConfigContext };
const writer = { client: { connect: { scopes: ["operator.write"] } }, context: emptyConfigContext };
function requests(
  service: Partial<Parameters<typeof createWorktreesHandlers>[0]>,
  defaults: Record<string, unknown> = {},
) {
  const handlers = createWorktreesHandlers(service as never);
  return async (method: string, params = {}, extras = defaults, respond = vi.fn()) => {
    await handlers[`worktrees.${method}`]?.({ params, respond, ...extras } as never);
    return respond.mock.calls[0];
  };
}
async function expectResult(request: ReturnType<ReturnType<typeof requests>>, expected: unknown) {
  const response = await request;
  expect(response).toEqual([true, expected, undefined]);
  return response?.[1];
}
function expectForbidden(response: Awaited<ReturnType<ReturnType<typeof requests>>>) {
  const scope = "operator.admin";
  expect(response?.[0]).toBe(false);
  expect(response?.[2]).toMatchObject({
    code: "FORBIDDEN",
    message: `missing scope: ${scope}`,
    details: { code: "MISSING_SCOPE", missingScope: scope, requiredScopes: [scope] },
  });
}

it("routes checkout operations through the managed worktree service", async () => {
  const deferred: ManagedWorktreeRecord = {
    ...record,
    gcProtection: "branch-moved",
    gcRetry: { stage: "snapshot", elapsedMs: 120_000, attempts: 1, retryAt: 7_200_000 },
  };
  const removed = { removed: true, snapshotRef: "refs/snapshot" };
  const restored = { ...record, snapshotRef: removed.snapshotRef };
  const service = {
    list: vi.fn(async () => [deferred]),
    create: vi.fn(async () => deferred),
    remove: vi.fn(async () => removed),
    restore: vi.fn(async () => ({ ...deferred, snapshotRef: removed.snapshotRef })),
  };
  const invoke = requests(service);
  const createParams = { repoRoot: "/repo", name: "task-one", baseRef: "main" };

  const listed = await expectResult(invoke("list"), { worktrees: [record] });
  await expectResult(invoke("create", createParams, admin), record);
  await expectResult(invoke("remove", { id: record.id, force: true }), removed);
  const restoredResult = await expectResult(invoke("restore", { id: record.id }), restored);
  expect(Value.Check(WorktreeRecordSchema, restoredResult)).toBe(true);
  expect(Value.Check(WorktreesListResultSchema, listed)).toBe(true);
  // mock-isolation: Response projection consumes an already accepted local owner.
  using ownerGuard = vi.spyOn(localStateOwner, "captureLocalStateMutationGuard");
  ownerGuard.mockReturnValue(() => {});
  for (const [method, params] of [
    ["create", { repoRoot: "/repo" }],
    ["restore", { id: record.id }],
  ] as const) {
    const qualified = await expectResult(
      invoke(method, { ...params, expectedOwnerId: "gateway-owner" }, admin),
      expect.objectContaining({ gcProtection: "branch-moved" }),
    );
    expect(Value.Check(WorktreeRecordSchema, qualified)).toBe(true);
    expect(qualified).not.toHaveProperty("gcRetry");
  }
  expect(service.create).toHaveBeenCalledWith({
    ...createParams,
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
    listRepositoryBranches: vi.fn(async () => ({ branches: [] })),
  };
  const invoke = requests(service, admin);

  for (const includeRepositoryStatus of [false, true]) {
    const options = includeRepositoryStatus ? { includeRepositoryStatus: true } : {};
    const response = await invoke("branches", { repoRoot: "/anywhere", ...options });
    expect(response?.[0]).toBe(true);
    expect(service.listRepositoryBranches).toHaveBeenCalledWith(
      "/anywhere",
      ...(includeRepositoryStatus ? [options] : []),
    );
  }

  const denied = await invoke("branches", { repoRoot: "/anywhere" }, writer);
  expectForbidden(denied);
});

it("authorizes registered project aliases but not outside paths", async () => {
  const root = tempDirs.make("openclaw-branches-project-");
  const repoRoot = await fs.realpath(
    await initializeGitFixture(root, "registered", "README.md", "registered\n"),
  );
  const alias = path.join(root, "registered-link");
  const outside = path.join(root, "outside");
  await fs.symlink(repoRoot, alias, "dir");
  await fs.mkdir(outside);
  const project = await registerProjectRegistry({ path: repoRoot, name: "Registered" });
  const service = {
    create: vi.fn(async () => record),
    listRepositoryBranches: vi.fn(async () => ({ branches: [] })),
  };
  const invoke = requests(service, writer);
  try {
    const allowed = await invoke("branches", { repoRoot: alias });
    expect(allowed?.[0]).toBe(true);
    expect(service.listRepositoryBranches).toHaveBeenCalledWith(repoRoot);

    const created = await invoke("create", {
      repoRoot: alias,
      name: "registered-task",
    });
    expect(created?.[0]).toBe(true);
    expect(service.create).toHaveBeenCalledWith({
      repoRoot,
      name: "registered-task",
      baseRef: undefined,
      ownerKind: "manual",
      runSetupScript: false,
    });

    expectForbidden(await invoke("branches", { repoRoot: outside }));
  } finally {
    await removeProjectRegistry(project);
  }
});

it("returns queued, running and completed GC receipts", async () => {
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
  const invoke = requests({}, { context });
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
    issues: [{ id: "retained", stage: "idle", outcome: "failed", reason: "offline" }],
  };
  try {
    const request = invoke("gc", {}, undefined, respond);
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
    const pending = await invoke("gc", { jobId: receipt.jobId });
    expect(pending?.[1]).toMatchObject({ jobId: receipt.jobId, state: "running" });
    sweep.resolve(result);
    await running;
    const completed = await expectResult(
      invoke("gc", { jobId: receipt.jobId }),
      expect.objectContaining({ ...result, jobId: receipt.jobId, state: "completed" }),
    );
    expect(Value.Check(WorktreesGcResultSchema, completed)).toBe(true);
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
  const invoke = requests(service);
  await expectResult(invoke("remove", { id: record.id }), {
    removed: false,
    snapshotError: "nested gitlink",
  });
});

it.each([
  ["create", { repoRoot: "" }],
  ["remove", { id: record.id, force: true, ifLossless: true }],
])("refuses invalid %s parameters before admitting a mutation", async (method, params) => {
  const response = await requests({})(method, params);

  expect(response?.[0]).toBe(false);
  expect(response?.[2]).toMatchObject({
    code: "INVALID_REQUEST",
    details: { mutationAccepted: false },
  });
});

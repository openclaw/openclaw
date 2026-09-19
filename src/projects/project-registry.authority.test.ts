import path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withWorktreeAllocationLease } from "../agents/worktrees/allocation.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { selectStoredProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.kernel.js";

const fixture = vi.hoisted(() => ({
  expiresAt: 40_000,
  resolveProject: vi.fn<() => Promise<ProjectRegistryRecord>>(),
  settlement: vi.fn<() => Promise<SqliteWorkerOperationSettlement>>(),
  afterCallback: vi.fn<() => void>(),
  captureWorkerGuard: vi.fn<(assertCurrent: () => void) => void>(),
  assertDatabaseCurrent: vi.fn<() => void>(),
  release: vi.fn(),
  forbiddenNative: vi.fn(() => {
    throw new Error("Project authority controls must not open SQLite, Git, or heartbeat workers");
  }),
}));

vi.mock("../agents/agent-scope-config.js", () => ({ withAgentRosterFactsBatch: vi.fn() }));
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));
vi.mock("../agents/worktrees/git.js", () => ({
  insideGitCheckout: fixture.forbiddenNative,
  runGit: fixture.forbiddenNative,
}));
vi.mock("./project-registration.js", () => ({ registerResolvedProject: vi.fn() }));
vi.mock("./project-registry.kernel.js", () => ({
  ensureProjectRegistrySchema: fixture.forbiddenNative,
  removeProjectCheckoutReferenceInDatabase: fixture.forbiddenNative,
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: fixture.forbiddenNative,
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  runOpenClawStateWriteTransaction: fixture.forbiddenNative,
}));
vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly: fixture.forbiddenNative,
}));
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: (databasePath: string) => ({
    databasePath,
    assertCurrent: fixture.assertDatabaseCurrent,
  }),
}));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));
vi.mock("../infra/state-database-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/state-database-coordinator.js")>();
  return {
    StateDatabaseCoordinatorContentionError: actual.StateDatabaseCoordinatorContentionError,
    captureStateDatabaseCoordinatorRuntime: () => ({
      directory: "/synthetic-coordinator",
      keepAlive: false,
    }),
  };
});
vi.mock("../state/openclaw-state-lease-storage.js", () => ({
  prepareLeaseDatabase: fixture.forbiddenNative,
  resolveLeaseDatabasePath: () => path.resolve("/synthetic-state/lease.sqlite"),
  readLeaseDatabase: (_database: unknown, run: () => unknown) => run(),
  withLeaseWriteTransaction: (_database: unknown, _label: string, run: () => unknown) => run(),
}));
vi.mock("../state/openclaw-state-lease-store.js", () => ({
  acquireOpenClawStateLeaseInTransaction: () => fixture.expiresAt,
  readOpenClawStateLeaseExpiry: () =>
    Date.now() < fixture.expiresAt ? fixture.expiresAt : undefined,
  renewOpenClawStateLeaseInTransaction: () => {
    fixture.expiresAt = Date.now() + 30_000;
    return fixture.expiresAt;
  },
  releaseOpenClawStateLeaseInTransaction: fixture.release,
}));
vi.mock("../state/openclaw-state-lease-exclusion.js", () => ({
  createOpenClawStateLeaseExclusion: () => ({
    canRelease: () => true,
    assertIfExcluded: () => false,
    runWithOwnerScope: (run: () => Promise<unknown>) => run(),
    drain: async () => {},
  }),
}));
vi.mock("../state/openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: fixture.forbiddenNative,
}));

type WorkerOptions = {
  assertCurrent?: () => void;
  createAdmission?: SqliteWorkerAdmissionFactory;
};
type ProjectReadScope = {
  execute: () => Promise<ProjectRegistryRecord>;
};

// Storage and transport are synthetic; admission retention and lease drainage
// use their production owners, including the real admission port cleanup.
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: () => fixture.resolveProject(),
  runOpenClawStateWorkerOperation: async <T>(
    context: OpenClawStateWorkerContext,
    operation: (scope: ProjectReadScope) => Promise<T>,
    options: WorkerOptions,
  ): Promise<T> => {
    context.admission.assertCurrent();
    if (!options.assertCurrent || !options.createAdmission) {
      throw new Error("Selector must retain its operation guard and worker admission");
    }
    options.assertCurrent();
    fixture.captureWorkerGuard(options.assertCurrent);
    const retained = options.createAdmission({ settled: fixture.settlement() });
    try {
      return await operation({ execute: () => fixture.resolveProject() });
    } finally {
      retained.admission.finish();
      fixture.afterCallback();
    }
  },
}));

const project: ProjectRegistryRecord = {
  id: "registered-project",
  displayName: "Project",
  source: "registered",
  repoRoot: path.resolve("/synthetic-repository/project"),
};
type Selection = NonNullable<Awaited<ReturnType<typeof selectStoredProjectRegistry>>>;
type Current = Parameters<Parameters<Selection["withCurrent"]>[0]>[0];

async function select(signal?: AbortSignal): Promise<Selection> {
  const selected = await selectStoredProjectRegistry(project.id, {
    path: path.resolve("/synthetic-state/lease.sqlite"),
    env: { HOME: "/synthetic-home", OPENCLAW_STATE_DIR: "/synthetic-state" },
    signal,
  });
  if (!selected) {
    throw new Error("Synthetic project was not selected");
  }
  return selected;
}

async function nextMessageTurn(): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  try {
    await new Promise<void>((resolve) => {
      port1.once("message", () => resolve());
      port2.postMessage(undefined);
    });
  } finally {
    port1.close();
    port2.close();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.forbiddenNative.mockImplementation(() => {
    throw new Error("Project authority controls must not open SQLite, Git, or heartbeat workers");
  });
  fixture.resolveProject.mockResolvedValue(project);
  fixture.settlement.mockResolvedValue({ kind: "completed" });
  fixture.expiresAt = 40_000;
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  expect(fixture.forbiddenNative).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it("retains only live checkout rollback authority after cancellation inside the callback", async () => {
  const caller = new AbortController();
  const abortCause = new Error("Caller canceled setup");
  const changedDatabase = new Error("Captured database admission was revoked");
  const selected = await select(caller.signal);
  let escaped: Current | undefined;
  let workerGuard: (() => void) | undefined;
  let observedProject: ProjectRegistryRecord | undefined;
  let signalAborted: boolean | undefined;
  let signalReason: unknown;
  let operationFailure: unknown;
  let workerFailure: unknown;
  let revokedDatabaseFailure: unknown;
  const rollbackEffect = vi.fn();
  const forwardEffect = vi.fn();
  fixture.captureWorkerGuard.mockImplementation((guard) => {
    workerGuard = guard;
  });

  const operation = selected.withCurrent(async (current) => {
    escaped = current;
    observedProject = current.project;
    caller.abort(abortCause);
    signalAborted = current.signal.aborted;
    signalReason = current.signal.reason;
    try {
      current.assertCurrent();
      forwardEffect();
    } catch (error) {
      operationFailure = error;
    }
    try {
      workerGuard?.();
    } catch (error) {
      workerFailure = error;
    }
    current.assertCheckoutCurrent();
    rollbackEffect();
    try {
      fixture.assertDatabaseCurrent.mockImplementation(() => {
        throw changedDatabase;
      });
      current.assertCheckoutCurrent();
    } catch (error) {
      revokedDatabaseFailure = error;
    } finally {
      fixture.assertDatabaseCurrent.mockReset();
    }
    throw abortCause;
  });

  await expect(operation).rejects.toMatchObject({
    code: "OPENCLAW_STATE_LEASE_ABORTED",
    cause: abortCause,
  });
  expect(observedProject).toEqual(project);
  expect(signalAborted).toBe(true);
  expect(signalReason).toBe(abortCause);
  expect(rollbackEffect).toHaveBeenCalledOnce();
  expect(operationFailure).toBe(abortCause);
  expect(workerGuard).toBeTypeOf("function");
  expect(workerFailure).toBe(abortCause);
  expect(revokedDatabaseFailure).toBe(changedDatabase);
  expect(forwardEffect).not.toHaveBeenCalled();
  expect(escaped).toBeDefined();
  expect(() => escaped?.assertCheckoutCurrent()).toThrow();
  expect(() => escaped?.assertCurrent()).toThrow();
});

it.each(["completed", "not-entered"] as const)(
  "preserves the exact callback failure for known %s settlement",
  async (kind) => {
    const failure = new Error("Known setup failure");
    fixture.settlement.mockResolvedValue(
      kind === "completed" ? { kind } : { kind, error: failure },
    );
    const selected = await select();
    await expect(
      selected.withCurrent(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fixture.release).toHaveBeenCalledOnce();
  },
);

it.each(["completed", "not-entered", "unknown"] as const)(
  "joins retained %s settlement and observes cancellation after the callback exits",
  async (kind) => {
    const caller = new AbortController();
    const selected = await select(caller.signal);
    const retained = createDeferredCore<SqliteWorkerOperationSettlement>();
    const callbackExited = createDeferredCore();
    const failure = new Error("Callback failed before native settlement arrived");
    const abortCause = new Error("Caller canceled during settlement drain");
    const settlementError = new Error("Native result remained unknown");
    let escaped: Current | undefined;
    let observed = false;
    fixture.settlement.mockReturnValue(retained.promise);
    fixture.afterCallback.mockImplementation(() => callbackExited.resolve());
    const operation = selected.withCurrent(async (current) => {
      escaped = current;
      throw failure;
    });
    const joined = operation.then(
      (value) => {
        observed = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        observed = true;
        return { ok: false as const, error };
      },
    );
    try {
      await Promise.race([
        callbackExited.promise,
        joined.then(() => {
          throw new Error("Selector settled before its retained worker callback exited");
        }),
      ]);
      await nextMessageTurn();
      expect(observed).toBe(false);
      expect(fixture.release).not.toHaveBeenCalled();
      expect(escaped).toBeDefined();
      expect(() => escaped?.assertCheckoutCurrent()).toThrow();
      expect(() => escaped?.assertCurrent()).toThrow();
      caller.abort(abortCause);
      await nextMessageTurn();
      expect(observed).toBe(false);
      retained.resolve(
        kind === "completed"
          ? { kind }
          : { kind, error: kind === "unknown" ? settlementError : failure },
      );
      const result = await joined;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Selector unexpectedly succeeded");
      }
      expect(result.error).toMatchObject({
        code: kind === "unknown" ? "outcome-unknown" : "OPENCLAW_STATE_LEASE_ABORTED",
      });
      const causes = collectNestedErrorCandidates(result.error);
      expect(causes).toContain(abortCause);
      if (kind === "unknown") {
        expect(causes).toContain(failure);
        expect(causes).toContain(settlementError);
        expect(fixture.release).not.toHaveBeenCalled();
      } else {
        expect(fixture.release).toHaveBeenCalledOnce();
      }
    } finally {
      retained.resolve({ kind: "completed" });
      await joined;
    }
  },
);

it.each(["known", "unknown", "wrapped-unknown"] as const)(
  "preserves the selected %s outcome through allocation cancellation",
  async (outcome) => {
    const caller = new AbortController();
    const abortCause = new Error("Caller canceled the allocated operation");
    const callbackFailure = new Error("Selected callback failed");
    const settlementError = new Error("Selected native outcome remained unknown");
    const cleanupFailure = new Error("Related cleanup failed");
    const retained = createDeferredCore<SqliteWorkerOperationSettlement>();
    fixture.settlement.mockReturnValue(retained.promise);
    let selectedFailure: unknown;
    const operation = withWorktreeAllocationLease(
      { env: { OPENCLAW_STATE_DIR: "/synthetic-state" }, signal: caller.signal },
      async (allocation) => {
        const selected = await select(allocation.signal);
        try {
          return await selected.withCurrent(async () => {
            caller.abort(abortCause);
            retained.resolve(
              outcome === "known"
                ? { kind: "completed" }
                : { kind: "unknown", error: settlementError },
            );
            throw callbackFailure;
          });
        } catch (error) {
          selectedFailure =
            outcome === "wrapped-unknown"
              ? new AggregateError([error, cleanupFailure], "Selected work and cleanup failed", {
                  cause: error,
                })
              : error;
          throw selectedFailure;
        }
      },
    );
    const joined = operation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const result = await joined;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Cancelled allocation unexpectedly succeeded");
      }
      const causes = collectNestedErrorCandidates(result.error);
      expect(causes).toContain(abortCause);
      if (outcome === "known") {
        expect(result.error).toMatchObject({
          code: "OPENCLAW_STATE_LEASE_ABORTED",
          message: "managed worktree allocation lease operation was aborted",
          cause: abortCause,
        });
      } else {
        expect(result.error).toMatchObject({ code: "outcome-unknown" });
        if (outcome === "wrapped-unknown") {
          expect(causes).toContain(selectedFailure);
        } else {
          expect(result.error).toBe(selectedFailure);
        }
        expect(causes).toContain(callbackFailure);
        expect(causes).toContain(settlementError);
        if (outcome === "wrapped-unknown") {
          expect(causes).toContain(cleanupFailure);
        }
      }
    } finally {
      retained.resolve({ kind: "completed" });
      await joined;
    }
  },
);

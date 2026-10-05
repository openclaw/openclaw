import path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { withWorktreeAllocationLease } from "../agents/worktrees/allocation.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OpenClawStateLeaseError } from "../state/openclaw-state-lease-error.js";
import type { startOpenClawStateLeaseHeartbeat } from "../state/openclaw-state-lease-heartbeat.js";
import type { createOpenClawStateLeaseWorkerStorage } from "../state/openclaw-state-lease-worker-storage.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { removeClonedProjectCheckout } from "./project-clone.js";
import { selectStoredProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.types.js";

const fixture = vi.hoisted(() => ({
  expiresAt: 40_000,
  resolveProject: vi.fn<() => Promise<ProjectRegistryRecord>>(),
  removeReference: vi.fn<() => Promise<"missing" | "changed" | "remaining" | "final">>(),
  removeCheckout: vi.fn<() => Promise<void>>(),
  removeParent: vi.fn<() => Promise<void>>(),
  settlement: vi.fn<() => Promise<SqliteWorkerOperationSettlement>>(),
  afterCallback: vi.fn<() => void>(),
  captureWorkerGuard: vi.fn<(assertCurrent: () => void) => void>(),
  assertDatabaseCurrent: vi.fn<() => void>(),
  release: vi.fn(),
  startHeartbeat: vi.fn<typeof startOpenClawStateLeaseHeartbeat>(),
  forbiddenNative: vi.fn(() => {
    throw new Error("Project authority controls must not open SQLite, Git, or heartbeat workers");
  }),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    realpath: async (value: string) => value,
    rm: fixture.removeCheckout,
    rmdir: fixture.removeParent,
  },
}));
vi.mock("./project-clone-runtime.js", () => ({
  ProjectCloneError: class extends Error {
    constructor(_code: string, message: string) {
      super(message);
    }
  },
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
vi.mock("../state/openclaw-state-db-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-cache.js")>()),
  captureOpenClawStateDatabaseReadAdmission: (databasePath: string) => ({
    databasePath,
    coordinationKey: databasePath,
    identity: { key: `file:${databasePath}`, canonicalPath: databasePath },
    assertCurrent: fixture.assertDatabaseCurrent,
  }),
  registerOpenClawStateDatabaseAsyncResource: () => () => {},
}));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-async-lifecycle.js")>()),
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));
vi.mock("../state/openclaw-state-lease-worker-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-lease-worker-storage.js")>()),
  acquireLease: async () => ({ kind: "acquired", expiresAt: fixture.expiresAt }),
  createOpenClawStateLeaseWorkerStorage: (
    context: OpenClawStateWorkerContext,
  ): ReturnType<typeof createOpenClawStateLeaseWorkerStorage> => ({
    path: context.admission.databasePath,
    assertCurrent: () => context.admission.assertCurrent(),
    async withRetainedStartup(run, assertCurrent) {
      context.admission.assertCurrent();
      assertCurrent();
      return await run(context);
    },
    async acquire(owner) {
      return await owner.runLifecycle("acquire", async (admission) => {
        admission.assertCurrent();
        return { kind: "acquired" as const, expiresAt: fixture.expiresAt };
      });
    },
    verify: fixture.forbiddenNative,
    renew: fixture.forbiddenNative,
    startTimer: fixture.forbiddenNative,
    async release(owner) {
      await owner.runLifecycle("release", async (admission) => {
        admission.assertCurrent();
        fixture.release();
      });
    },
  }),
}));
vi.mock("../state/openclaw-state-lease-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-lease-storage.js")>()),
  prepareLeaseDatabase: fixture.forbiddenNative,
  resolveLeaseDatabasePath: () => path.resolve("/synthetic-state/lease.sqlite"),
  verifyOpenClawStateLeaseOwnership: () => {
    if (Date.now() >= fixture.expiresAt) {
      throw new OpenClawStateLeaseError("Synthetic lease ownership expired", {
        code: "OPENCLAW_STATE_LEASE_LOST",
      });
    }
    return fixture.expiresAt;
  },
  renewOpenClawStateLease: () => {
    fixture.expiresAt = Date.now() + 30_000;
    return fixture.expiresAt;
  },
  releaseOpenClawStateLeaseBestEffort: async (_params: unknown, execute?: () => Promise<void>) => {
    if (execute) {
      await execute();
    } else {
      fixture.release();
    }
  },
  releaseOpenClawStateLease: fixture.release,
}));
vi.mock("../state/openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: fixture.startHeartbeat,
}));

type WorkerOptions = {
  assertCurrent?: () => void;
  createAdmission?: SqliteWorkerAdmissionFactory;
};
type ProjectReadScope = {
  execute: (command: { type: string }) => Promise<unknown>;
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
      return await operation({
        execute: (command) =>
          command.type === "projects.removeCheckoutReference"
            ? fixture.removeReference()
            : fixture.resolveProject(),
      });
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
  fixture.startHeartbeat.mockImplementation(fixture.forbiddenNative);
  fixture.resolveProject.mockResolvedValue(project);
  fixture.removeReference.mockResolvedValue("final");
  fixture.removeCheckout.mockResolvedValue();
  fixture.removeParent.mockResolvedValue();
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

it.each([
  { kind: "completed", cancel: false },
  { kind: "not-entered", cancel: false },
  { kind: "completed", cancel: true },
  { kind: "not-entered", cancel: true },
  { kind: "unknown", cancel: true },
] as const)(
  "joins $kind settlement before choosing the callback or cancellation failure (cancel=$cancel)",
  async ({ kind, cancel }) => {
    const caller = new AbortController();
    const selected = await select(cancel ? caller.signal : undefined);
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
      if (cancel) {
        caller.abort(abortCause);
      }
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
      const causes = collectNestedErrorCandidates(result.error);
      if (cancel) {
        expect(result.error).toMatchObject({
          code: kind === "unknown" ? "outcome-unknown" : "OPENCLAW_STATE_LEASE_ABORTED",
        });
        expect(causes).toContain(abortCause);
      } else {
        expect(result.error).toBe(failure);
      }
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
    fixture.startHeartbeat.mockReturnValueOnce({
      ready: Promise.resolve(),
      assertRunning: vi.fn(),
      assertResponsive: vi.fn(),
      verify: async () => fixture.expiresAt,
      renew: fixture.forbiddenNative,
      close: fixture.forbiddenNative,
      stop: async () => 0,
    });
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

const clonedProject: ProjectRegistryRecord = {
  ...project,
  source: "cloned",
  repoRoot: path.resolve("/synthetic-state/projects/0123456789abcdef/project"),
};

function removeCheckout(assertUnreferenced: () => void | Promise<void> = () => {}) {
  return removeClonedProjectCheckout(clonedProject, assertUnreferenced, {
    path: path.resolve("/synthetic-state/lease.sqlite"),
    env: { OPENCLAW_STATE_DIR: "/synthetic-state" },
  });
}

it("retains checkout custody until the removal worker and native settlement finish", async () => {
  const result = createDeferredCore<"final">();
  const entered = createDeferredCore();
  const exited = createDeferredCore();
  const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
  fixture.removeReference.mockImplementation(() => {
    entered.resolve();
    return result.promise;
  });
  fixture.settlement.mockReturnValue(settled.promise);
  fixture.afterCallback.mockImplementation(() => exited.resolve());
  const operation = removeCheckout();
  try {
    await awaitGateBeforeSettlement(entered.promise, operation, "Removal bypassed the worker");
    expect(fixture.removeCheckout).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
    result.resolve("final");
    await awaitGateBeforeSettlement(exited.promise, operation, "Removal skipped native settlement");
    expect(fixture.removeCheckout).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
    settled.resolve({ kind: "completed" });
    await expect(operation).resolves.toBe(true);
    expect(fixture.removeCheckout).toHaveBeenCalledWith(clonedProject.repoRoot, {
      recursive: true,
    });
    expect(fixture.removeParent).toHaveBeenCalledWith(path.dirname(clonedProject.repoRoot));
    expect(fixture.release).toHaveBeenCalledOnce();
  } finally {
    result.resolve("final");
    settled.resolve({ kind: "completed" });
    await operation.catch(() => {});
  }
});

it.each(["rejected", "unknown", "lease", "database", "reference"] as const)(
  "preserves the checkout when removal has a %s outcome or authority",
  async (failureKind) => {
    const failure = new Error("Removal no longer authorized");
    const assertUnreferenced = vi.fn();
    if (failureKind === "rejected") {
      fixture.removeReference.mockRejectedValue(failure);
    } else if (failureKind === "unknown") {
      fixture.settlement.mockResolvedValue({ kind: "unknown", error: failure });
    } else {
      fixture.afterCallback.mockImplementation(() => {
        if (failureKind === "lease") {
          fixture.expiresAt = Date.now();
        } else if (failureKind === "database") {
          fixture.assertDatabaseCurrent.mockImplementation(() => {
            throw failure;
          });
        } else {
          assertUnreferenced.mockImplementation(() => {
            throw failure;
          });
        }
      });
    }
    const operation = removeCheckout(assertUnreferenced);
    if (failureKind === "unknown" || failureKind === "lease") {
      await expect(operation).rejects.toMatchObject({
        code: failureKind === "unknown" ? "outcome-unknown" : "OPENCLAW_STATE_LEASE_LOST",
      });
    } else {
      await expect(operation).rejects.toBe(failure);
    }
    expect(fixture.removeReference).toHaveBeenCalledOnce();
    expect(fixture.removeCheckout).not.toHaveBeenCalled();
    expect(fixture.removeParent).not.toHaveBeenCalled();
    if (failureKind === "reference") {
      expect(assertUnreferenced).toHaveBeenCalledTimes(2);
    }
  },
);

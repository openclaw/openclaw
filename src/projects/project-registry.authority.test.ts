import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observe } from "../state/openclaw-state-lease-async.test-support.js";
import { OpenClawStateLeaseError } from "../state/openclaw-state-lease-error.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { removeClonedProjectCheckout } from "./project-clone.js";
import { selectStoredProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.types.js";

// Capture before fake timers: settlement needs a real event-loop turn.
const nextMessageTurn = setImmediate;

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
  createOpenClawStateLeaseWorkerStorage: fixture.forbiddenNative,
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
// mock-isolation: project checkout leases must not start native heartbeat workers.
vi.mock("../state/openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: fixture.forbiddenNative,
}));

type WorkerOptions = {
  assertCurrent?: () => void;
  createAdmission?: SqliteWorkerAdmissionFactory;
};
type ProjectReadScope = {
  execute: (command: { type: string }) => Promise<unknown>;
};

// mock-isolation: Use synthetic storage with real admission retention and lease drainage.
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
    const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
    const retained = options.createAdmission({ settled: settled.promise });
    try {
      return await operation({
        execute: (command) => {
          settled.resolve(fixture.settlement());
          return command.type === "projects.removeCheckoutReference"
            ? fixture.removeReference()
            : fixture.resolveProject();
        },
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

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function observeFailure(operation: Promise<unknown>) {
  const observed = observe(operation);
  const error = observed.outcome.then((result) => {
    if (result.ok) {
      throw new Error("Operation unexpectedly succeeded");
    }
    return result.error;
  });
  return { settled: observed.settled, error };
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.forbiddenNative.mockImplementation(() => {
    throw new Error("Project authority controls must not open SQLite, Git, or heartbeat workers");
  });
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
  const inspect = vi.fn((current: Current) => ({
    project: current.project,
    signalAborted: current.signal.aborted,
    signalReason: current.signal.reason,
    operationFailure: thrownBy(current.assertCurrent),
    workerFailure: thrownBy(() => workerGuard?.()),
    workerGuard,
    checkoutCurrent: current.assertCheckoutCurrent(),
  }));
  let revokedDatabaseFailure: unknown;
  fixture.captureWorkerGuard.mockImplementation((guard) => {
    workerGuard = guard;
  });

  const operation = selected.withCurrent(async (current) => {
    escaped = current;
    caller.abort(abortCause);
    inspect(current);
    fixture.assertDatabaseCurrent.mockImplementation(() => {
      throw changedDatabase;
    });
    revokedDatabaseFailure = thrownBy(current.assertCheckoutCurrent);
    fixture.assertDatabaseCurrent.mockReset();
    throw abortCause;
  });

  await expect(operation).rejects.toMatchObject({
    code: "OPENCLAW_STATE_LEASE_ABORTED",
    cause: abortCause,
  });
  const observed = inspect.mock.results[0]?.value;
  expect(observed?.project).toEqual(project);
  expect(observed?.signalAborted).toBe(true);
  expect(observed?.signalReason).toBe(abortCause);
  expect(observed?.operationFailure).toBe(abortCause);
  expect(observed?.workerGuard).toBeTypeOf("function");
  expect(observed?.workerFailure).toBe(abortCause);
  expect(revokedDatabaseFailure).toBe(changedDatabase);
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
    fixture.settlement.mockReturnValue(retained.promise);
    fixture.afterCallback.mockImplementation(() => callbackExited.resolve());
    const operation = selected.withCurrent(async (current) => {
      escaped = current;
      throw failure;
    });
    const { settled, error: joined } = observeFailure(operation);
    try {
      await awaitGateBeforeSettlement(
        callbackExited.promise,
        joined,
        "Selector settled before its retained worker callback exited",
      );
      await nextMessageTurn();
      expect(settled()).toBe(false);
      expect(fixture.release).not.toHaveBeenCalled();
      expect(escaped).toBeDefined();
      expect(() => escaped?.assertCheckoutCurrent()).toThrow();
      expect(() => escaped?.assertCurrent()).toThrow();
      if (cancel) {
        caller.abort(abortCause);
      }
      await nextMessageTurn();
      expect(settled()).toBe(false);
      retained.resolve(
        kind === "completed"
          ? { kind }
          : { kind, error: kind === "unknown" ? settlementError : failure },
      );
      const error = await joined;
      const causes = collectNestedErrorCandidates(error);
      if (cancel) {
        expect(error).toMatchObject({
          code: kind === "unknown" ? "outcome-unknown" : "OPENCLAW_STATE_LEASE_ABORTED",
        });
        expect(causes).toContain(abortCause);
      } else {
        expect(error).toBe(failure);
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

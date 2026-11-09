import assert from "node:assert/strict";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OpenClawStateLeaseError } from "../state/openclaw-state-lease-error.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { removeClonedProjectCheckout } from "./project-clone.js";
import { selectStoredProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.types.js";

// Capture before fake timers: settlement needs a real event-loop turn.
const nextMessageTurn = setImmediate;

const fixture = vi.hoisted(() => {
  const forbiddenNative = vi.fn(() => {
    throw new Error("Unexpected SQLite, Git, or heartbeat worker");
  });
  return {
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
    forbiddenNative,
    forbid: (...names: string[]) =>
      Object.fromEntries(names.map((name) => [name, forbiddenNative] as const)),
  };
});

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
// mock-isolation: authority fixtures must not inspect or mutate a native checkout.
vi.mock("../agents/worktrees/git.js", () => fixture.forbid("insideGitCheckout", "runGit"));
// mock-isolation: the worker fixture owns registry operations without native SQLite.
vi.mock("./project-registry.kernel.js", () =>
  fixture.forbid("ensureProjectRegistrySchema", "removeProjectCheckoutReferenceInDatabase"),
);
// mock-isolation: fail if authority-only proof attempts to open a native database.
vi.mock("../infra/node-sqlite.js", () => fixture.forbid("openNodeSqliteDatabase"));
// mock-isolation: worker receipts replace native state transactions in this fixture.
vi.mock("../state/openclaw-state-db.js", () => fixture.forbid("runOpenClawStateWriteTransaction"));
// mock-isolation: database admission is supplied by the fixture, not native storage.
vi.mock("../state/openclaw-state-db-readonly.js", () =>
  fixture.forbid("withExistingOpenClawStateDatabaseArtifactPreservingReadOnly"),
);
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
  renewOpenClawStateLease: fixture.forbiddenNative,
  releaseOpenClawStateLeaseBestEffort: async (_params: unknown, execute?: () => Promise<void>) =>
    execute ? execute() : fixture.release(),
  releaseOpenClawStateLease: fixture.release,
}));
// mock-isolation: project checkout leases must not start native heartbeat workers.
vi.mock("../state/openclaw-state-lease-heartbeat.js", () =>
  fixture.forbid("startOpenClawStateLeaseHeartbeat"),
);

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
  id: "project",
  displayName: "Project",
  source: "cloned",
  repoRoot: path.resolve("/synthetic-state/projects/0123456789abcdef/project"),
};
type Selection = NonNullable<Awaited<ReturnType<typeof selectStoredProjectRegistry>>>;
type Current = Parameters<Parameters<Selection["withCurrent"]>[0]>[0];

async function select(signal?: AbortSignal): Promise<Selection> {
  const selected = await selectStoredProjectRegistry(project.id, {
    path: path.resolve("/synthetic-state/lease.sqlite"),
    env: { HOME: "/synthetic-home", OPENCLAW_STATE_DIR: "/synthetic-state" },
    signal,
  });
  assert(selected, "Synthetic project was not selected");
  return selected;
}

beforeEach(() => {
  vi.resetAllMocks();
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

it("does not classify a protected callback failure as busy source acquisition", async () => {
  const selected = await select();
  const failure = new OpenClawStateLeaseError("Another lease in the protected operation is busy", {
    code: "OPENCLAW_STATE_LEASE_HELD",
  });
  await expect(
    selected.withCurrent(
      () => {
        throw failure;
      },
      { waitMs: 0 },
    ),
  ).rejects.toBe(failure);
});

it.each(["callback", "drain"] as const)(
  "retains checkout custody when cancellation arrives during %s",
  async (phase) => {
    const caller = new AbortController();
    const abortCause = new Error("Caller canceled setup");
    const changedDatabase = new Error("Captured database admission was revoked");
    const selected = await select(caller.signal);
    const retained = createDeferredCore<SqliteWorkerOperationSettlement>();
    const exited = createDeferredCore();
    let escaped: Current | undefined;
    const inspect = vi.fn((current: Current) => {
      const workerGuard = fixture.captureWorkerGuard.mock.lastCall?.[0];
      expect(current.signal.aborted).toBe(true);
      expect(current.signal.reason).toBe(abortCause);
      assert.throws(current.assertCurrent, (error) => error === abortCause);
      expect(workerGuard).toBeTypeOf("function");
      assert.throws(
        () => workerGuard?.(),
        (error) => error === abortCause,
      );
      current.assertCheckoutCurrent();
      fixture.assertDatabaseCurrent.mockImplementation(() => {
        throw changedDatabase;
      });
      assert.throws(current.assertCheckoutCurrent, (error) => error === changedDatabase);
      fixture.assertDatabaseCurrent.mockReset();
    });
    fixture.settlement.mockReturnValue(retained.promise);
    fixture.afterCallback.mockImplementation(() => exited.resolve());
    const operation = selected.withCurrent(async (current) => {
      escaped = current;
      if (phase === "callback") {
        caller.abort(abortCause);
        inspect(current);
        throw abortCause;
      }
      throw new Error("Callback failed before native settlement");
    });
    const settled = vi.fn();
    const joined = operation.catch((error: unknown) => error).finally(settled);
    try {
      await awaitGateBeforeSettlement(exited.promise, joined, "Selector skipped its callback");
      await nextMessageTurn();
      expect(settled).not.toHaveBeenCalled();
      expect(fixture.release).not.toHaveBeenCalled();
      expect(escaped).toBeDefined();
      expect(() => escaped?.assertCheckoutCurrent()).toThrow();
      expect(() => escaped?.assertCurrent()).toThrow();
      if (phase === "drain") {
        caller.abort(abortCause);
      }
      await nextMessageTurn();
      expect(settled).not.toHaveBeenCalled();
      retained.resolve({ kind: "completed" });
      const error = await joined;
      expect(error).toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      expect(collectNestedErrorCandidates(error)).toContain(abortCause);
      expect(fixture.release).toHaveBeenCalledOnce();
      // Cancellation can mask callback assertions; verify them independently.
      if (phase === "callback") {
        expect(inspect).toHaveReturned();
      }
      expect(() => escaped?.assertCheckoutCurrent()).toThrow();
      expect(() => escaped?.assertCurrent()).toThrow();
    } finally {
      retained.resolve({ kind: "completed" });
      await joined;
    }
  },
);

function removeCheckout(assertUnreferenced: () => void | Promise<void> = () => {}) {
  return removeClonedProjectCheckout(project, assertUnreferenced, {
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
    expect(fixture.removeCheckout).toHaveBeenCalledWith(project.repoRoot, {
      recursive: true,
    });
    expect(fixture.removeParent).toHaveBeenCalledWith(path.dirname(project.repoRoot));
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
    expect(fixture.removeCheckout).not.toHaveBeenCalled();
    expect(fixture.removeParent).not.toHaveBeenCalled();
  },
);

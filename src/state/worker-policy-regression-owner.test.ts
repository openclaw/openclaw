import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const fixture = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock("../infra/abort-signal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/abort-signal.js")>()),
  racePromiseWithAbortSignal: (p: Promise<unknown>) => p,
}));
vi.mock("../infra/runtime-process-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-process-url.js")>()),
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///fixture/worker.js"),
}));
vi.mock("../infra/runtime-worker-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-worker-generation.js")>()),
  captureRuntimeWorkerSource: (moduleUrl: URL) => ({ moduleUrl }),
}));
vi.mock("../infra/sqlite-handle-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-handle-lifecycle.js")>()),
  SQLITE_IDLE_HANDLE_TTL_MS: 999999,
}));
// mock-isolation: Keep real broker actors and worker processes outside this retained-actor fixture.
vi.mock("../infra/sqlite-worker-store.js", () => ({
  openSharedStateSqliteWorkerStore: fixture.open,
  closeUnclaimedSharedStateSqliteWorkers: async () => {},
  hasUnclaimedSharedStateSqliteCleanup: () => false,
  isSqliteWorkerStoreAvailable: () => true,
  getSqliteWorkerActorIdentity: () => ({ identity: { key: "file:fixture" } }),
  retireSqliteWorkerActor: async () => {},
  SqliteWorkerError: Error,
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn: () => {} }),
}));
vi.mock("../shared/detached-async-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/detached-async-context.js")>()),
  runInDetachedAsyncContext: (f: () => unknown) => f(),
}));
vi.mock("../shared/global-singleton.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/global-singleton.js")>()),
  resolveGlobalSingleton: (_key: unknown, f: () => unknown) => f(),
}));
vi.mock("../shared/listeners.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/listeners.js")>()),
  notifyListeners: () => {},
}));
// mock-isolation: Keep the process-wide database cache and lifecycle registrations outside this owner-only fixture.
vi.mock("./openclaw-state-db-cache.js", () => ({
  publishOpenClawStateDatabaseWorkerAdmission: () => {},
  assertPublishedOpenClawStateDatabaseLifecycle: () => {},
  registerOpenClawStateDatabaseAsyncResource: () => {},
  registerOpenClawStateDatabaseLifecycleListener: () => {},
}));
vi.mock("./openclaw-state-worker-memory-pressure.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-worker-memory-pressure.js")>()),
  createStateWorkerMemoryPressureSubscription: () => () => {},
}));
vi.mock("./openclaw-state-worker-operation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-worker-operation.js")>()),
  assertOpenClawStateWorkerActorPath: () => {},
  assertOpenClawStateWorkerSchemaContext: () => {},
  captureOpenClawStateWorkerOpeningGuard: () => ({
    run: (f: () => unknown) => f(),
    assertCurrent: () => {},
  }),
}));
import { getOpenClawStateWorkerOwner } from "./openclaw-state-worker-owner.js";
const installation = {
  root: "/old",
  version: "2026.10.5",
  cliVersion: "2026.10.8",
  databasePath: "/fixture.db",
};
function context(policy: typeof installation | undefined): OpenClawStateWorkerContext {
  return {
    gatewayServiceInstallation: policy,
    admission: {
      identity: { key: "file:fixture" },
      databasePath: "/fixture.db",
      assertCurrent: () => {},
    },
    environment: {},
  } as OpenClawStateWorkerContext;
}
describe("worker policy owner comparisons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.open.mockImplementation(async () => ({
      execute: async () => undefined,
      close: fixture.close,
    }));
    fixture.close.mockResolvedValue(undefined);
  });
  it("reuses a live actor for equivalent cloned installation facts", async () => {
    const owner = getOpenClawStateWorkerOwner();
    const store = (await owner.open(context(installation)))!;
    const release = owner.retainOperation(store);
    try {
      expect(await owner.open(context(structuredClone(installation)))).toBe(store);
      expect(fixture.open).toHaveBeenCalledTimes(1);
      expect(fixture.close).not.toHaveBeenCalled();
    } finally {
      await release();
      await owner.close();
    }
  });
  it.each(["root", "version", "cliVersion", "databasePath"] as const)(
    "refuses changed %s while actor is retained, without joining close",
    async (field) => {
      const owner = getOpenClawStateWorkerOwner();
      const store = (await owner.open(context(installation)))!;
      const release = owner.retainOperation(store);
      try {
        await expect(
          owner.open(context({ ...installation, [field]: installation[field] + "-changed" })),
        ).rejects.toThrow("policy changed while its actor is in use");
        expect(fixture.close).not.toHaveBeenCalled();
      } finally {
        await release();
        await owner.close();
      }
    },
  );
  it.each([false, true])(
    "refuses missing/present policy transitions with a retained actor (%s)",
    async (reverse) => {
      const owner = getOpenClawStateWorkerOwner();
      const store = (await owner.open(context(reverse ? installation : undefined)))!;
      const release = owner.retainOperation(store);
      try {
        await expect(owner.open(context(reverse ? undefined : installation))).rejects.toThrow(
          "policy changed while its actor is in use",
        );
        expect(fixture.close).not.toHaveBeenCalled();
      } finally {
        await release();
        await owner.close();
      }
    },
  );
  it("refuses to join an already-retiring actor held by a live operation", async () => {
    let settleClose!: () => void;
    fixture.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleClose = resolve;
        }),
    );
    const owner = getOpenClawStateWorkerOwner();
    const store = (await owner.open(context(installation)))!;
    const release = owner.retainOperation(store);
    const closing = owner.close();
    await expect(owner.open(context(structuredClone(installation)))).rejects.toThrow(
      "is retiring while its actor is in use",
    );
    await release();
    settleClose();
    await closing;
  });
  it("can retire a quiescent actor for genuinely different policy", async () => {
    const owner = getOpenClawStateWorkerOwner();
    await owner.open(context(installation));
    await owner.open(context({ ...installation, root: "/different" }));
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.open).toHaveBeenCalledTimes(2);
    await owner.close();
  });
});

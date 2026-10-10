// Register worker mocks before loading the production module graph.
import "./session-history-worker-errors.test-support.js";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readChatHistoryDelta } from "../../gateway/server-methods/chat-history-delta.js";
import { decodeAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import * as sqliteScope from "./session-accessor.sqlite-scope.js";
import {
  canonicalSessionKeyMigrationRequiredError,
  SessionCanonicalKeyMigrationRequiredError,
} from "./session-canonical-row.js";
import { readSessionHistoryPageInWorker } from "./session-history-worker-runtime.js";
import {
  historyLane,
  rotateDatabaseWorkers,
  targetDiscoveryLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

const closeCapabilities = vi.hoisted(() => ({ explicitSqliteCloseReleasesNativeResources: true }));
vi.mock("../../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/bun-sqlite-library.js")>()),
  ensureSqliteLibrarySelected: () => ({ source: "runtime" }),
  captureSqliteWorkerClosePolicy: () =>
    closeCapabilities.explicitSqliteCloseReleasesNativeResources,
  getSqliteRuntimeCapabilities: () => ({ ...closeCapabilities, reason: "test policy" }),
}));

const { createVisibilityFailureDelta, observed, typedFailures } =
  await import("./session-history-worker-errors.test-support.js");
await import("./session-transcript.worker.js");
let sequence = 0;
function input() {
  const database = { agentId: "main", path: `/synthetic/session-read-errors-${++sequence}.sqlite` };
  return {
    kind: "session-row-presence",
    database,
    scope: {
      agentId: "main",
      databaseAgentId: "main",
      sessionKey: "agent:main:errors",
      storePath: database.path,
    },
  };
}

// These lifecycle checks retain one already-admitted history lane.
function useAdmittedHistoryReader() {
  vi.spyOn(agentExecution, "captureExistingOpenClawAgentDatabaseExecution").mockImplementation(
    (options) => {
      const claim = { identity: "history", incarnation: "history", assertCurrent() {} };
      return {
        agentId: "main",
        path: options.path,
        fileIdentity: undefined,
        assertCurrent() {},
        captureGenerationClaim: () => claim,
        capturePreparedGenerationClaim: () => claim,
        async adoptNativeDatabase() {
          throw new Error("Readonly history must not adopt a writer");
        },
        async prepare() {
          throw new Error("Readonly history must not prepare a writer");
        },
        async runExisting() {
          throw new Error("Readonly history must not open a writer");
        },
        async release() {},
      };
    },
  );
}

function installWorkerTransport() {
  observed.run.mockImplementation(async (request, options) => {
    const posted = createDeferredCore<unknown>();
    observed.post.mockImplementation(posted.resolve);
    assert(observed.receive);
    observed.receive({
      input: request,
      taskId: 7,
      interactive: Boolean(options.onRequest),
      nativeSections: new SharedArrayBuffer(4),
      taskContext: { deletedAgentDatabaseFences: [], databaseAdmissions: [] },
    });
    const reply = await posted.promise;
    assert(reply && typeof reply === "object" && "status" in reply);
    if (reply.status === "failed") {
      assert("error" in reply && typeof reply.error === "string");
      throw new WorkerTaskError(reply.error, "failed");
    }
    assert(reply.status === "ok" && "value" in reply);
    return structuredClone(reply.value);
  });
}

async function readThroughWorker() {
  const request = input();
  installWorkerTransport();
  return await withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  );
}

beforeEach(() => {
  closeCapabilities.explicitSqliteCloseReleasesNativeResources = true;
  // Synthetic targets keep discovery outside the error-transfer worker controls.
  vi.spyOn(sqliteScope, "prepareSqliteTranscriptReadScope").mockImplementation(async (scope) =>
    sqliteScope.resolveSqliteTranscriptReadScope(scope),
  );
  observed.deferredRun = undefined;
  observed.post.mockReset();
  observed.read.mockReset();
  observed.delta.mockReset();
  observed.lookup.mockReset();
  observed.close.mockReset();
  observed.run.mockReset();
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.closeResources.mockReset().mockResolvedValue(undefined);
  observed.unregister.mockReset();
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  await Promise.all([historyLane, targetDiscoveryLane].map((lane) => rotateDatabaseWorkers(lane)));
  vi.restoreAllMocks();
  expect(observed.nativeWorker).not.toHaveBeenCalled();
});

function failingVisibilityDelta(resetFirst: boolean) {
  const request = input();
  observed.delta.mockReturnValue(createVisibilityFailureDelta(resetFirst));
  observed.lookup.mockImplementation(() => {
    throw canonicalSessionKeyMigrationRequiredError("invalid source metadata");
  });
  installWorkerTransport();
  return () =>
    readChatHistoryDelta({
      agentId: "main",
      sessionKey: request.scope.sessionKey,
      cursor: "cursor",
      sessionSnapshot: {},
      scope: {
        ...request.scope,
        sessionId: "delta",
        sessionEntry: { sessionId: "delta" },
      },
    });
}

it.each([
  { resetFirst: true, closeFails: false },
  { resetFirst: false, closeFails: false },
  { resetFirst: true, closeFails: true },
])(
  "preserves visibility ordering (reset=$resetFirst, close failure=$closeFails)",
  async ({ resetFirst, closeFails }) => {
    const read = failingVisibilityDelta(resetFirst);
    if (closeFails) {
      observed.close.mockImplementation(() => {
        throw new Error("primary close failed");
      });
      await expect(read()).rejects.toMatchObject({
        message: expect.stringContaining("primary close failed"),
      });
    } else if (resetFirst) {
      await expect(read()).resolves.toEqual({ kind: "reset" });
    } else {
      await expect(read()).rejects.toThrow("openclaw doctor --fix");
    }
    expect(observed.close).toHaveBeenCalledOnce();
    expect(observed.rotate).toHaveBeenCalledOnce();
  },
);

it.each(["revocation", "retirement-failure", "auxiliary-close"])(
  "settles failed visibility before reset and preserves %s",
  async (failure) => {
    const read = failingVisibilityDelta(true);
    if (failure === "auxiliary-close") {
      observed.lookup.mockImplementation(() => {
        throw new Error("shared-state reader close failed");
      });
    }
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.rotate.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    let settled = false;
    const pending = read()
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      expect(
        await Promise.race([entered.promise.then(() => "retiring"), pending.then(() => "settled")]),
      ).toBe("retiring");
      expect(settled).toBe(false);
      if (failure === "revocation") {
        expect(observed.resources).toHaveLength(1);
        observed.resources[0]!.revoke();
      }
      if (failure === "retirement-failure") {
        retirement.reject(new Error("retirement failed"));
      } else {
        retirement.resolve();
      }
      const result = await pending;
      if (failure === "auxiliary-close") {
        expect(result).toEqual({ value: { kind: "reset" } });
      } else {
        assert("error" in result);
        expect(result.error).toMatchObject({
          message: expect.stringContaining(
            failure === "revocation" ? "revoked" : "retirement failed",
          ),
        });
      }
    } finally {
      retirement.resolve();
      await pending;
    }
  },
);

it("rejects primary revocation between delta acquisition and consumption", async () => {
  failingVisibilityDelta(true);
  observed.lookup.mockReturnValue(false);
  const request = input();
  const prepared = await readSessionHistoryPageInWorker({
    kind: "delta",
    params: {
      target: {
        ...request.scope,
        sessionId: "delta",
        sessionEntry: { sessionId: "delta" },
      },
      limits: { cursor: "cursor", maxEvents: 200, maxBytes: 1_000_000 },
    },
  });
  expect(prepared.assertCurrent).not.toThrow();
  expect(observed.resources).toHaveLength(1);
  const resource = observed.resources[0]!;
  resource.revoke();
  expect(prepared.assertCurrent).toThrow("revoked");
  await resource.close();
});

const readFailures: Array<{ error: Error; reply?: (typeof typedFailures)[number]["reply"] }> = [
  { error: new Error("read failed") },
  { error: canonicalSessionKeyMigrationRequiredError("invalid source metadata") },
  ...typedFailures,
  {
    error: new SessionMetadataUnavailableError(
      "table-missing",
      {
        cause: Object.assign(new Error("synthetic SQLite read failure"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 1,
        }),
      },
      ["transcript_events"],
    ),
  },
];

it.each(
  readFailures.flatMap(({ error, reply }) =>
    [false, true].map((fails) => ({ error, reply, fails })),
  ),
)(
  "retains $error.message through the worker round trip (close failure=$fails)",
  async ({ error, reply, fails }) => {
    const cleanup = new Error("database close failed");
    observed.read.mockImplementation(() => {
      throw error;
    });
    if (fails) {
      observed.close.mockImplementation(() => {
        throw cleanup;
      });
    }
    const failure: unknown = await readThroughWorker().catch((caught: unknown) => caught);
    const primary: unknown = failure instanceof AggregateError ? failure.errors[0] : failure;
    if (
      !fails ||
      error instanceof SessionMetadataUnavailableError ||
      error instanceof SessionCanonicalKeyMigrationRequiredError
    ) {
      expect(primary).toBeInstanceOf(error.constructor);
    }
    expect(primary).toMatchObject({ name: error.name, message: error.message });
    if (error instanceof SessionMetadataUnavailableError) {
      expect(primary).toMatchObject({
        reason: "table-missing",
        missingTables: ["transcript_events"],
        cause: { message: "synthetic SQLite read failure", code: "ERR_SQLITE_ERROR", errcode: 1 },
      });
    }
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors).toMatchObject([
        { name: error.name, message: error.message },
        { message: cleanup.message },
      ]);
      expect(failure.cause).toBe(failure.errors[1]);
      expect(failure.message).toContain(error.message);
      expect(failure.message).toContain(cleanup.message);
    } else if (reply) {
      expect(observed.post).toHaveBeenCalledWith({
        status: "ok",
        taskId: 7,
        value: { ok: false, error: reply },
      });
    }
    expect(observed.close).toHaveBeenCalledOnce();
    expect(observed.rotate).toHaveBeenCalledOnce();
  },
);

it("retires idle history workers under critical pressure after active scopes release custody", async () => {
  useAdmittedHistoryReader();
  const pressure = channel("openclaw.memory.critical");
  const request = input();
  const retirement = createDeferredCore();
  const unregistered = createDeferredCore();
  observed.run.mockResolvedValue({ ok: true, value: false });
  observed.rotate.mockReturnValue(retirement.promise);
  observed.unregister.mockImplementation(unregistered.resolve);
  await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
    expect(await owner.readEntryPresence(request.scope)).toBe(false);
    pressure.publish(undefined);
    expect(observed.rotate).not.toHaveBeenCalled();
  });

  pressure.publish(undefined);
  expect(observed.rotate).toHaveBeenCalledTimes(1);
  expect(observed.unregister).not.toHaveBeenCalled();
  pressure.publish(undefined);
  expect(observed.rotate).toHaveBeenCalledTimes(1);
  retirement.resolve();
  await unregistered.promise;
  expect(observed.unregister).toHaveBeenCalledTimes(1);
});

it.each([
  { retired: true, fails: false },
  { retired: false, fails: false },
  { retired: false, fails: true },
])(
  "settles failed reads after pool retirement (already retired=$retired, failure=$fails)",
  async ({ retired, fails }) => {
    const earlier = input();
    observed.run.mockResolvedValueOnce({ ok: true, value: false });
    await withSessionHistoryWorkerDatabase(earlier.database, (owner) =>
      owner.readEntryPresence(earlier.scope),
    );
    const primary = new WorkerTaskError(
      "worker response failed",
      retired ? "unavailable" : "failed",
    );
    const cleanup = new Error("retirement failed");
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockImplementation(async (_request, options) => {
      if (retired) {
        options.onExecutionSettled?.({ retired: true });
      }
      throw primary;
    });
    observed.rotate.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    const request = input();
    let settled = false;
    const pending = withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      expect(
        await Promise.race([pending.then(() => "settled"), entered.promise.then(() => "rotating")]),
      ).toBe("rotating");
    } catch (error) {
      retirement.resolve();
      throw error;
    }
    expect(settled).toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    if (fails) {
      retirement.reject(cleanup);
    } else {
      retirement.resolve();
    }
    const failure: unknown = await pending;
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors).toEqual([primary, cleanup]);
      expect(failure.cause).toBe(cleanup);
      expect(failure.message).toContain(primary.message);
      expect(failure.message).toContain(cleanup.message);
      expect(observed.unregister).not.toHaveBeenCalled();
    } else {
      expect(failure).toBe(primary);
      expect(observed.unregister).toHaveBeenCalledTimes(2);
    }
  },
);

it("retains aliases until native cleanup and preserves later read custody", async () => {
  useAdmittedHistoryReader();
  const request = input();
  const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
  const cleanupEntered = createDeferredCore();
  const cleanup = createDeferredCore();
  observed.run.mockResolvedValue({ ok: true, value: false });
  observed.closeResources.mockImplementation(() => {
    cleanupEntered.resolve();
    return cleanup.promise;
  });
  const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
    observed.run.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: "session-store-target",
        logicalAgentId: "main",
        sourcePath: request.database.path,
        database: request.database,
      },
    });
    await scope.readStoreTarget({
      agentId: "main",
      storePath: request.database.path,
      env: {},
      registeredDatabases: [],
    });
    await withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    );
    candidates[0]!.physicalPath = "/synthetic/replacement.sqlite";
  });
  await cleanupEntered.promise;
  expect(observed.unregister).not.toHaveBeenCalled();
  expect(observed.rotate).not.toHaveBeenCalled();
  // This read is newer than the captured cleanup sequence, even on the same physical path.
  await withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  );
  cleanup.resolve();
  await discovery;
  expect(decodeAgentDatabaseReaderRequest(observed.closeResources.mock.calls[0]?.[0])).toEqual({
    kind: "close",
    candidates: [{ path: request.database.path }],
    retainedPaths: [request.database.path],
    deleted: false,
  });
  expect(observed.unregister).toHaveBeenCalledTimes(1);
  const retained = observed.resources.find((resource) => resource.agentId === "main");
  assert(retained);
  await retained.close();
  expect(observed.closeResources).toHaveBeenCalledTimes(2);
  expect(observed.rotate).not.toHaveBeenCalled();
});

it.each([
  { fails: false, capable: false },
  { fails: false, capable: true },
  { fails: true, capable: false },
  { fails: true, capable: true },
])(
  "joins idle cleanup and retains failed custody (fails=$fails, capable=$capable)",
  async ({ fails, capable }) => {
    useAdmittedHistoryReader();
    closeCapabilities.explicitSqliteCloseReleasesNativeResources = capable;
    const request = input();
    observed.run.mockResolvedValue({ ok: true, value: false });
    await withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    );
    const resource = observed.resources.find((entry) => entry.agentId === "main");
    assert(resource);
    const failure = new Error("idle database native close failed");
    const retirementFailure = new Error("idle database worker retirement failed");
    const retirementEntered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.closeResources.mockRejectedValueOnce(failure);
    observed.rotate.mockImplementationOnce(() => {
      retirementEntered.resolve();
      return retirement.promise;
    });
    resource.revoke();
    const closing = resource.close().catch((error: unknown) => error);
    await retirementEntered.promise;
    expect(observed.unregister).not.toHaveBeenCalled();
    if (!capable) {
      if (fails) {
        retirement.reject(retirementFailure);
        expect(await closing).toBe(retirementFailure);
        expect(observed.unregister).not.toHaveBeenCalled();
        await resource.close();
      } else {
        retirement.resolve();
        expect(await closing).toBeUndefined();
      }
      expect(observed.closeResources).not.toHaveBeenCalled();
      expect(observed.unregister).toHaveBeenCalledOnce();
      return;
    }
    if (fails) {
      retirement.reject(retirementFailure);
      const result = await closing;
      assert(result instanceof AggregateError);
      expect(result.errors).toEqual([failure, retirementFailure]);
      expect(observed.unregister).not.toHaveBeenCalled();
      await resource.close();
    } else {
      retirement.resolve();
      expect(await closing).toBe(failure);
    }
    expect(observed.unregister).toHaveBeenCalledOnce();
    expect(observed.closeResources).toHaveBeenCalledWith(
      JSON.stringify([{ path: request.database.path }]),
    );
  },
);

it("settles candidate handles before registry continuation without retiring the worker", async () => {
  const request = input();
  const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
  const cleanupEntered = createDeferredCore();
  const cleanup = createDeferredCore();
  observed.run
    .mockResolvedValueOnce({ ok: true, value: { kind: "session-target-registry-required" } })
    .mockResolvedValueOnce({ ok: true, value: { kind: "session-target-inventory", agents: [] } });
  observed.closeResources.mockImplementationOnce(() => {
    cleanupEntered.resolve();
    return cleanup.promise;
  });
  let continued = false;
  const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
    const inventory = { config: {}, agentIds: ["main"], env: {}, paths: new Map() };
    expect(
      await scope.readTargetInventory({
        ...inventory,
        registeredDatabases: { status: "deferred" },
      }),
    ).toEqual({ kind: "session-target-registry-required" });
    continued = true;
    expect(
      await scope.readTargetInventory({
        ...inventory,
        registeredDatabases: [],
      }),
    ).toEqual({ kind: "session-target-inventory", agents: [] });
  });
  try {
    await Promise.race([cleanupEntered.promise, discovery]);
    expect(continued).toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    expect(observed.rotate).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    await discovery;
  }
  expect(continued).toBe(true);
  expect(observed.closeResources).toHaveBeenCalledTimes(2);
  expect(observed.closeResources).toHaveBeenCalledWith(
    JSON.stringify([{ path: request.database.path }]),
  );
  expect(observed.rotate).not.toHaveBeenCalled();
  expect(observed.unregister).toHaveBeenCalledTimes(1);
});

it.each([
  { fails: false, capable: true },
  { fails: true, capable: true },
  { fails: false, capable: false },
])(
  "joins candidate cleanup retirement (failure=$fails, native close=$capable)",
  async ({ fails, capable }) => {
    closeCapabilities.explicitSqliteCloseReleasesNativeResources = capable;
    const request = input();
    const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
    const failure = new Error("candidate native close failed");
    const retirementEntered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockResolvedValue({
      ok: true,
      value: {
        kind: "session-store-target",
        logicalAgentId: "main",
        sourcePath: request.database.path,
        database: request.database,
      },
    });
    observed.closeResources.mockRejectedValue(failure);
    observed.rotate.mockImplementation(() => {
      retirementEntered.resolve();
      return retirement.promise;
    });
    const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
      await scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        env: {},
        registeredDatabases: [],
      });
    });
    const settled = discovery.catch((error: unknown) => error);
    await retirementEntered.promise;
    expect(observed.unregister).not.toHaveBeenCalled();
    if (fails) {
      const retirementFailure = new Error("candidate worker retirement failed");
      retirement.reject(retirementFailure);
      const error = await settled;
      assert(error instanceof AggregateError);
      expect(error.errors).toEqual([failure, retirementFailure]);
      expect(observed.unregister).not.toHaveBeenCalled();
    } else {
      retirement.resolve();
      expect(await settled).toBe(capable ? failure : undefined);
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    }
    expect(observed.rotate).toHaveBeenCalledOnce();
    expect(observed.closeResources).toHaveBeenCalledTimes(capable ? 1 : 0);
  },
);

it.each([
  { reason: "read-failed", capable: true },
  { reason: "database-missing", capable: false },
  { reason: "database-missing", capable: true },
  { reason: "registry-required-after-failure", capable: true },
])("settles inventory readers for $reason (capable=$capable)", async ({ reason, capable }) => {
  closeCapabilities.explicitSqliteCloseReleasesNativeResources = capable;
  const request = input();
  const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
  observed.run.mockResolvedValue({
    ok: true,
    value:
      reason === "registry-required-after-failure"
        ? { kind: "session-target-registry-required", readFailed: true }
        : {
            kind: "session-target-inventory",
            agents: [{ agentId: "main", result: { available: false, reason }, reads: [] }],
          },
  });
  await withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
    await scope.readTargetInventory({
      config: {},
      agentIds: ["main"],
      env: {},
      paths: new Map(),
      registeredDatabases: [],
    });
  });
  const retired = reason !== "database-missing" || !capable;
  expect(observed.closeResources).toHaveBeenCalledTimes(retired ? 0 : 1);
  expect(observed.rotate).toHaveBeenCalledTimes(
    reason === "registry-required-after-failure" ? 2 : retired ? 1 : 0,
  );
});

it.each([false, true])(
  "keeps alias custody through overlapping retirement when retirement fails=%s",
  async (fails) => {
    const request = input();
    const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
    const cleanupEntered = createDeferredCore();
    const cleanup = createDeferredCore();
    const retirementEntered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockResolvedValue({
      ok: true,
      value: {
        kind: "session-store-target",
        logicalAgentId: "main",
        sourcePath: request.database.path,
        database: request.database,
      },
    });
    observed.closeResources.mockImplementation(() => {
      cleanupEntered.resolve();
      return cleanup.promise;
    });
    observed.rotate.mockImplementation(() => {
      retirementEntered.resolve();
      return retirement.promise;
    });
    const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
      await scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        env: {},
        registeredDatabases: [],
      });
    });
    let settled = false;
    const result = discovery
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await cleanupEntered.promise;
    const alias = observed.resources.find((resource) => !resource.agentId);
    assert(alias?.revoke);
    alias.revoke();
    const closing = alias.close().catch((error: unknown) => error);
    await retirementEntered.promise;
    try {
      cleanup.resolve();
      await cleanup.promise;
      expect(settled).toBe(false);
      expect(observed.unregister).not.toHaveBeenCalled();
      const revoked = { message: "Session reader custody was revoked during discovery cleanup" };
      if (fails) {
        const failure = new Error("overlapping retirement failed");
        retirement.reject(failure);
        expect(await closing).toBe(failure);
        const error = await result;
        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toMatchObject({ errors: [revoked, failure], cause: failure });
        expect(observed.unregister).not.toHaveBeenCalled();
        observed.rotate.mockResolvedValueOnce(undefined);
        await alias.close();
      } else {
        retirement.resolve();
        await closing;
        expect(await result).toMatchObject(revoked);
      }
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve();
      retirement.resolve();
      await Promise.allSettled([discovery, closing]);
    }
  },
);

it.each([
  { kind: "store", capable: false },
  { kind: "inventory", capable: true },
])(
  "binds queued $kind discovery and byte accounting to admitted candidates (capable=$capable)",
  async ({ kind, capable }) => {
    closeCapabilities.explicitSqliteCloseReleasesNativeResources = capable;
    const admitted = {
      path: "/synthetic/admitted.sqlite",
      physicalPath: "/synthetic/physical.sqlite",
      scope: "sibling-family" as const,
    };
    const original = { ...admitted };
    const foreign = {
      path: "/synthetic/foreign.sqlite",
      physicalPath: "/synthetic/foreign.sqlite",
    };
    const entered = createDeferredCore();
    const response = createDeferredCore<unknown>();
    let prepare: (() => unknown) | undefined;
    let inputBytes: number | undefined;
    observed.deferredRun = (inputFactory, options) => {
      prepare = inputFactory;
      inputBytes = options.inputBytes;
      entered.resolve();
      return response.promise;
    };
    const storeRequest = {
      agentId: "main",
      storePath: foreign.path,
      env: { OPENCLAW_STATE_DIR: path.resolve("/synthetic/state") },
      registeredDatabases: [],
      candidates: [foreign],
    };
    const paths = new Map([
      [
        "main",
        { configured: "/synthetic/configured.sqlite", default: "/synthetic/default.sqlite" },
      ],
    ]);
    const inventoryRequest = {
      config: {},
      agentIds: ["main"],
      env: { OPENCLAW_STATE_DIR: path.resolve("/synthetic/state") },
      paths,
      registeredDatabases: [],
      candidates: [foreign],
    };
    const discovery = withSessionHistoryWorkerReadCandidates<unknown>([admitted], (scope) =>
      kind === "store"
        ? scope.readStoreTarget(storeRequest)
        : scope.readTargetInventory(inventoryRequest),
    );
    await entered.promise;
    admitted.path = "/synthetic/changed-alias.sqlite";
    admitted.physicalPath = "/synthetic/changed-physical.sqlite";
    foreign.path = "/synthetic/widened.sqlite";
    foreign.physicalPath = foreign.path;
    try {
      assert(prepare);
      expect(prepare()).toMatchObject({ request: { candidates: [original] } });
      const dispatched = {
        ...(kind === "store" ? storeRequest : inventoryRequest),
        candidates: [original],
      };
      let expectedBytes = JSON.stringify(dispatched).length * 2;
      if (kind === "inventory") {
        for (const [agentId, target] of paths) {
          expectedBytes += 2 * (agentId.length + target.configured.length + target.default.length);
        }
      }
      expect(inputBytes).toBe(expectedBytes);
    } finally {
      response.resolve({
        ok: true,
        value:
          kind === "store"
            ? {
                kind: "session-store-target",
                logicalAgentId: "main",
                sourcePath: original.physicalPath,
                database: { agentId: "main", path: original.physicalPath },
              }
            : { kind: "session-target-inventory", agents: [] },
      });
      await discovery;
    }
    if (capable) {
      expect(observed.closeResources).toHaveBeenCalledWith(
        JSON.stringify([{ path: original.physicalPath, scope: original.scope }]),
      );
    } else {
      expect(observed.closeResources).not.toHaveBeenCalled();
      expect(observed.rotate).toHaveBeenCalledOnce();
    }
  },
);

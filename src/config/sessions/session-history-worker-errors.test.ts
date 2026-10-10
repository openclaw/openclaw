// Register worker mocks before loading the production module graph.
import "./session-history-worker-errors.test-support.js";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readChatHistoryDelta } from "../../gateway/server-methods/chat-history-delta.js";
import { decodeAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import * as sqliteAdmission from "../../infra/sqlite-database-admission.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
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
  vi.spyOn(sqliteAdmission, "hasSqliteDatabaseSchemaAdmissionForPath").mockReturnValue(true);
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
  const retired = !capable;
  expect(observed.closeResources).toHaveBeenCalledTimes(retired ? 0 : 1);
  expect(observed.rotate).toHaveBeenCalledTimes(retired ? 1 : 0);
});

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

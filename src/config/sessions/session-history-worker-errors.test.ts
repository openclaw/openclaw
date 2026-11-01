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
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
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
  const database = { agentId: "main", path: `/reader-${++sequence}.sqlite` };
  const scope = {
    agentId: "main",
    databaseAgentId: "main",
    sessionKey: "agent:main:errors",
    storePath: database.path,
  };
  return {
    database,
    scope,
    candidates: [{ path: database.path, physicalPath: database.path }],
    inventory: {
      config: {},
      agentIds: ["main"],
      env: {},
      paths: new Map(),
      registeredDatabases: [],
    },
    read: () =>
      withSessionHistoryWorkerDatabase(database, (owner) => owner.readEntryPresence(scope)),
  };
}

const workerReply = <T>(value: T) => ({ ok: true, value });
const emptyInventory = () => ({ kind: "session-target-inventory", agents: [] });
const throwError = (error: Error) => () => {
  throw error;
};
function expectCustody(closed: number, retired: number, unregistered?: number) {
  expect(observed.closeResources).toHaveBeenCalledTimes(closed);
  expect(observed.rotate).toHaveBeenCalledTimes(retired);
  if (unregistered !== undefined) {
    expect(observed.unregister).toHaveBeenCalledTimes(unregistered);
  }
}
const storeTarget = (database: { agentId: string; path: string }) => ({
  kind: "session-store-target",
  logicalAgentId: database.agentId,
  sourcePath: database.path,
  database,
});

function deltaTarget() {
  return { ...input().scope, sessionId: "delta", sessionEntry: { sessionId: "delta" } };
}

function deferCleanup(once = false) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  observed.closeResources[once ? "mockImplementationOnce" : "mockImplementation"](() => {
    entered.resolve();
    return release.promise;
  });
  return { entered: entered.promise, release: release.resolve };
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
      taskContext: { deletedAgentDatabaseFences: [] },
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
  return await request.read();
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  closeCapabilities.explicitSqliteCloseReleasesNativeResources = true;
  // Synthetic targets keep discovery outside the error-transfer worker controls.
  vi.spyOn(sqliteScope, "prepareSqliteTranscriptReadScope").mockImplementation(async (scope) =>
    sqliteScope.resolveSqliteTranscriptReadScope(scope),
  );
  observed.deferredRun = undefined;
  for (const key of ["post", "read", "delta", "lookup", "close", "run", "unregister"] as const) {
    observed[key].mockReset();
  }
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.closeResources.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  await Promise.all([historyLane, targetDiscoveryLane].map((lane) => rotateDatabaseWorkers(lane)));
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  expect(observed.nativeWorker).not.toHaveBeenCalled();
});

function failingVisibilityDelta(resetFirst: boolean) {
  const scope = deltaTarget();
  observed.delta.mockReturnValue(createVisibilityFailureDelta(resetFirst));
  observed.lookup.mockImplementation(
    throwError(canonicalSessionKeyMigrationRequiredError("invalid source metadata")),
  );
  installWorkerTransport();
  return () =>
    readChatHistoryDelta({
      agentId: "main",
      sessionKey: scope.sessionKey,
      cursor: "cursor",
      sessionSnapshot: {},
      scope,
    });
}

it.each([
  [true, false],
  [false, false],
  [true, true],
])("preserves visibility ordering (reset=%s, close failure=%s)", async (resetFirst, closeFails) => {
  const read = failingVisibilityDelta(resetFirst);
  if (closeFails) {
    observed.close.mockImplementation(throwError(new Error("primary close failed")));
    await expect(read()).rejects.toMatchObject({
      message: expect.stringContaining("primary close failed"),
    });
  } else if (resetFirst) {
    await expect(read()).resolves.toEqual({ kind: "reset" });
  } else {
    await expect(read()).rejects.toThrow("openclaw doctor --fix");
  }
  expect(observed.close).toHaveBeenCalledOnce();
});

it("rejects primary revocation between delta acquisition and consumption", async () => {
  failingVisibilityDelta(true);
  observed.lookup.mockReturnValue(false);
  const prepared = await readSessionHistoryPageInWorker({
    kind: "delta",
    params: {
      target: deltaTarget(),
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
    observed.read.mockImplementation(throwError(error));
    if (fails) {
      observed.close.mockImplementation(throwError(cleanup));
    }
    const failure: unknown = await readThroughWorker().catch((caught: unknown) => caught);
    const primary: unknown = failure instanceof AggregateError ? failure.errors[0] : failure;
    const expectedError = { name: error.name, message: error.message };
    if (
      !fails ||
      error instanceof SessionMetadataUnavailableError ||
      error instanceof SessionCanonicalKeyMigrationRequiredError
    ) {
      expect(primary).toBeInstanceOf(error.constructor);
    }
    expect(primary).toMatchObject(expectedError);
    if (error instanceof SessionMetadataUnavailableError) {
      expect(primary).toMatchObject({
        reason: "table-missing",
        missingTables: ["transcript_events"],
        cause: { message: "synthetic SQLite read failure", code: "ERR_SQLITE_ERROR", errcode: 1 },
      });
    }
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors).toMatchObject([expectedError, { message: cleanup.message }]);
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
  observed.run.mockResolvedValue(workerReply(false));
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
  const { database, candidates, read } = input();
  const cleanup = deferCleanup();
  observed.run.mockResolvedValue(workerReply(false));
  const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
    observed.run.mockResolvedValueOnce(workerReply(storeTarget(database)));
    await scope.readStoreTarget({
      agentId: "main",
      storePath: database.path,
      env: {},
      registeredDatabases: [],
    });
    await read();
    candidates[0]!.physicalPath = "/synthetic/replacement.sqlite";
  });
  await cleanup.entered;
  expect(observed.unregister).not.toHaveBeenCalled();
  expect(observed.rotate).not.toHaveBeenCalled();
  // This read is newer than the captured cleanup sequence, even on the same physical path.
  await read();
  cleanup.release();
  await discovery;
  expect(decodeAgentDatabaseReaderRequest(observed.closeResources.mock.calls[0]?.[0])).toEqual({
    kind: "close",
    candidates: [{ path: database.path }],
    retainedPaths: [database.path],
    deleted: false,
  });
  expect(observed.unregister).toHaveBeenCalledTimes(1);
  const retained = observed.resources.find((resource) => resource.agentId === "main");
  assert(retained);
  await retained.close();
  expectCustody(2, 0);
});

it("settles candidate handles before registry continuation without retiring the worker", async () => {
  const { database, candidates, inventory } = input();
  const cleanup = deferCleanup(true);
  observed.run
    .mockResolvedValueOnce(workerReply({ kind: "session-target-registry-required" }))
    .mockResolvedValueOnce(workerReply(emptyInventory()));
  let continued = false;
  const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
    expect(
      await scope.readTargetInventory({
        ...inventory,
        registeredDatabases: { status: "deferred" },
      }),
    ).toEqual({ kind: "session-target-registry-required" });
    continued = true;
    expect(await scope.readTargetInventory(inventory)).toEqual(emptyInventory());
  });
  try {
    await Promise.race([cleanup.entered, discovery]);
    expect(continued).toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    expect(observed.rotate).not.toHaveBeenCalled();
  } finally {
    cleanup.release();
    await discovery;
  }
  expect(continued).toBe(true);
  expectCustody(2, 0, 1);
  expect(observed.closeResources).toHaveBeenCalledWith(JSON.stringify([{ path: database.path }]));
});

it.each([
  ["read-failed", true],
  ["database-missing", false],
  ["database-missing", true],
  ["registry-required-after-failure", true],
] as const)("settles inventory readers for %s (capable=%s)", async (reason, capable) => {
  closeCapabilities.explicitSqliteCloseReleasesNativeResources = capable;
  const { candidates, inventory } = input();
  observed.run.mockResolvedValue(
    workerReply(
      reason === "registry-required-after-failure"
        ? { kind: "session-target-registry-required", readFailed: true }
        : {
            kind: "session-target-inventory",
            agents: [{ agentId: "main", result: { available: false, reason }, reads: [] }],
          },
    ),
  );
  await withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
    await scope.readTargetInventory(inventory);
  });
  const retired = !capable;
  expectCustody(retired ? 0 : 1, retired ? 1 : 0);
});

it.each([
  ["store", false],
  ["inventory", true],
] as const)(
  "binds queued %s discovery and byte accounting to admitted candidates (capable=%s)",
  async (kind, capable) => {
    closeCapabilities.explicitSqliteCloseReleasesNativeResources = capable;
    const admitted = {
      path: "/admitted.sqlite",
      physicalPath: "/physical.sqlite",
      scope: "sibling-family" as const,
    };
    const original = { ...admitted };
    const foreign = { path: "/foreign.sqlite", physicalPath: "/foreign.sqlite" };
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
    const common = {
      env: { OPENCLAW_STATE_DIR: path.resolve("/synthetic/state") },
      registeredDatabases: [],
      candidates: [foreign],
    };
    const storeRequest = { ...common, agentId: "main", storePath: foreign.path };
    const paths = new Map([
      ["main", { configured: "/configured.sqlite", default: "/default.sqlite" }],
    ]);
    const inventoryRequest = { config: {}, agentIds: ["main"], ...common, paths };
    const discovery = withSessionHistoryWorkerReadCandidates<unknown>([admitted], (scope) =>
      kind === "store"
        ? scope.readStoreTarget(storeRequest)
        : scope.readTargetInventory(inventoryRequest),
    );
    await entered.promise;
    admitted.path = "/changed-alias.sqlite";
    admitted.physicalPath = "/changed-physical.sqlite";
    foreign.path = "/widened.sqlite";
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
      response.resolve(
        workerReply(
          kind === "store"
            ? storeTarget({ agentId: "main", path: original.physicalPath })
            : emptyInventory(),
        ),
      );
      await discovery;
    }
    if (capable) {
      expect(observed.closeResources).toHaveBeenCalledWith(
        JSON.stringify([{ path: original.physicalPath, scope: original.scope }]),
      );
    } else {
      expectCustody(0, 1);
    }
  },
);

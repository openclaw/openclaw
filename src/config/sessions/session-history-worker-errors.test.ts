// Register worker mocks before loading the production module graph.
import "./session-history-worker-errors.test-support.js";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readChatHistoryDelta } from "../../gateway/server-methods/chat-history-delta.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import * as sqliteScope from "./session-accessor.sqlite-scope.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-row.js";
import { readSessionHistoryPageInWorker } from "./session-history-worker-runtime.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

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
function invoke(request: ReturnType<typeof input>) {
  assert(observed.handler);
  return Promise.resolve(observed.handler(request));
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
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
  observed.quarantinePaths.clear();
  observed.quarantineRead.mockReset().mockReturnValue({ user_version: 0 });
  observed.quarantineClose.mockReset();
  observed.quarantineOpen.mockReset().mockImplementation(() => {
    const database: ReturnType<typeof observed.quarantineOpen> = {
      isOpen: true,
      exec() {},
      prepare: () => ({ get: observed.quarantineRead }),
      close() {
        observed.quarantineClose();
        database.isOpen = false;
      },
    };
    return database;
  });
  observed.hydrate.mockReset().mockReturnValue({
    kind: "full",
    eventCount: 0,
    version: { generation: null, rawSeq: null, updatedAt: null },
  });
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  vi.restoreAllMocks();
  expect(observed.nativeWorker).not.toHaveBeenCalled();
});

it("preserves the worker read failure through transfer when closing succeeds", async () => {
  const primary = new Error("read failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  await expect(readThroughWorker()).rejects.toMatchObject({ message: primary.message });
  expect(observed.close).toHaveBeenCalledTimes(1);
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

it.each([true, false])(
  "preserves lazy visibility error ordering after retirement (reset first: %s)",
  async (resetFirst) => {
    const read = failingVisibilityDelta(resetFirst);
    if (resetFirst) {
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

it("keeps primary close failures fatal even when an earlier delta row resets", async () => {
  const read = failingVisibilityDelta(true);
  observed.close.mockImplementation(() => {
    throw new Error("primary close failed");
  });
  await expect(read()).rejects.toMatchObject({
    message: expect.stringContaining("primary close failed"),
  });
  expect(observed.rotate).toHaveBeenCalledOnce();
});

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

it("retains both worker errors through transfer when the read and close fail", async () => {
  const primary = new Error("read failed");
  const cleanup = new Error("database close failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  observed.close.mockImplementation(() => {
    throw cleanup;
  });
  const failure: unknown = await readThroughWorker().catch((error: unknown) => error);
  assert(failure instanceof AggregateError);
  expect(failure.errors).toMatchObject([
    { message: primary.message },
    { message: cleanup.message },
  ]);
  expect(failure.cause).toBe(failure.errors[1]);
  expect(failure.message).toContain(primary.message);
  expect(failure.message).toContain(cleanup.message);
});

it.each(typedFailures)(
  "keeps typed $reply.kind recovery when closing succeeds",
  async ({ error, reply }) => {
    observed.read.mockImplementation(() => {
      throw error;
    });
    await expect(invoke(input())).resolves.toEqual({ ok: false, error: reply });
    expect(observed.close).toHaveBeenCalledTimes(1);
  },
);
it.each(typedFailures)(
  "does not recover typed $reply.kind reads when close also fails",
  async ({ error }) => {
    const cleanup = new Error("close failed");
    observed.read.mockImplementation(() => {
      throw error;
    });
    observed.close.mockImplementation(() => {
      throw cleanup;
    });
    const failure: unknown = await readThroughWorker().catch((caught: unknown) => caught);
    assert(failure instanceof AggregateError);
    expect(failure.errors).toMatchObject([
      { name: error.name, message: error.message },
      { message: cleanup.message },
    ]);
    expect(failure.cause).toBe(failure.errors[1]);
  },
);

it.each([false, true])(
  "retains typed metadata refusal and SQLite cause across worker transfer with cleanup failure=%s",
  async (fails) => {
    const cause = Object.assign(new Error("synthetic SQLite read failure"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 1,
    });
    const primary = new SessionMetadataUnavailableError("table-missing", { cause }, [
      "transcript_events",
    ]);
    const cleanup = new Error("synthetic database close failure");
    observed.read.mockImplementation(() => {
      throw primary;
    });
    if (fails) {
      observed.close.mockImplementation(() => {
        throw cleanup;
      });
    }
    const failure: unknown = await readThroughWorker().catch((error: unknown) => error);
    const unavailable: unknown = failure instanceof AggregateError ? failure.errors[0] : failure;
    expect(unavailable).toBeInstanceOf(SessionMetadataUnavailableError);
    expect(unavailable).toMatchObject({
      reason: "table-missing",
      missingTables: ["transcript_events"],
      cause: { message: cause.message, code: "ERR_SQLITE_ERROR", errcode: 1 },
    });
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors[1]).toMatchObject({ message: cleanup.message });
      expect(failure.cause).toBe(failure.errors[1]);
    }
  },
);

it("retires idle history workers under critical pressure after active scopes release custody", async () => {
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

it("settles an already-retired read without waiting for a healthy successor rotation", async () => {
  const primary = new WorkerTaskError("retired read cancelled", "unavailable");
  const rotationStarted = createDeferredCore();
  const successorRelease = createDeferredCore();
  observed.run.mockImplementation(async (_request, options) => {
    options.onExecutionSettled?.({ retired: true });
    throw primary;
  });
  observed.rotate.mockImplementation(() => {
    rotationStarted.resolve();
    return successorRelease.promise;
  });
  const request = input();
  const pending = withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  ).catch((error: unknown) => error);
  try {
    expect(
      await Promise.race([
        pending.then(() => "settled"),
        rotationStarted.promise.then(() => "rotating successor"),
      ]),
    ).toBe("settled");
    expect(await pending).toBe(primary);
  } finally {
    successorRelease.resolve();
    await pending;
  }
});

it.each([false, true])(
  "awaits retirement and preserves both failures when retirement fails=%s",
  async (fails) => {
    const primary = new WorkerTaskError("worker response failed", "failed");
    const cleanup = new Error("retirement failed");
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockRejectedValue(primary);
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
    await entered.promise;
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
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(typedFailures)(
  "preserves typed $reply.kind errors after successful parent retirement",
  async ({ error, reply }) => {
    observed.run.mockResolvedValue({ ok: false, error: reply });
    const request = input();
    const failure: unknown = await withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    ).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(error.constructor);
    expect(failure).toMatchObject({ message: error.message });
    expect(observed.rotate).toHaveBeenCalledTimes(1);
  },
);

it.runIf(!process.versions.bun)(
  "retains aliases until native cleanup and preserves later read custody",
  async () => {
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
    expect(observed.closeResources).toHaveBeenCalledWith(
      JSON.stringify([{ path: request.database.path }]),
    );
    expect(observed.unregister).toHaveBeenCalledTimes(1);
    const retained = observed.resources.find((resource) => resource.agentId === "main");
    assert(retained);
    await retained.close();
    expect(observed.closeResources).toHaveBeenCalledTimes(2);
    expect(observed.rotate).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "joins idle database cleanup retirement and retains failed custody (retirement fails=%s)",
  async (fails) => {
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
    if (process.versions.bun) {
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

it.runIf(!process.versions.bun)(
  "settles candidate handles before registry continuation without retiring the worker",
  async () => {
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
  },
);

it.runIf(!process.versions.bun).each([false, true])(
  "joins candidate cleanup retirement and retains custody when retirement fails=%s",
  async (fails) => {
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
      expect(await settled).toBe(failure);
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    }
  },
);

it("keeps native worker retirement for Bun candidate cleanup", async () => {
  const request = input();
  const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
  if (!descriptor) {
    Object.defineProperty(process.versions, "bun", { value: "synthetic-bun", configurable: true });
  }
  observed.run.mockResolvedValue({
    ok: true,
    value: {
      kind: "session-store-target",
      logicalAgentId: "main",
      sourcePath: request.database.path,
      database: request.database,
    },
  });
  try {
    await withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
      await scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        env: {},
        registeredDatabases: [],
      });
    });
    expect(observed.closeResources).not.toHaveBeenCalled();
    expect(observed.rotate).toHaveBeenCalledTimes(1);
    expect(observed.unregister).toHaveBeenCalledTimes(1);
  } finally {
    if (!descriptor) {
      Reflect.deleteProperty(process.versions, "bun");
    }
  }
});

it.each(["read-failed", "database-missing", "registry-required-after-failure"] as const)(
  "settles inventory readers for %s",
  async (reason) => {
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
    const retired = reason !== "database-missing" || Boolean(process.versions.bun);
    expect(observed.closeResources).toHaveBeenCalledTimes(retired ? 0 : 1);
    expect(observed.rotate).toHaveBeenCalledTimes(
      reason === "registry-required-after-failure" ? 2 : retired ? 1 : 0,
    );
  },
);

it.runIf(!process.versions.bun).each([false, true])(
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
    const result = discovery.catch((error: unknown) => error);
    await cleanupEntered.promise;
    const alias = observed.resources.find((resource) => !resource.agentId);
    assert(alias?.revoke);
    alias.revoke();
    const closing = alias.close().catch((error: unknown) => error);
    await retirementEntered.promise;
    try {
      cleanup.resolve();
      expect(await result).toMatchObject({ message: "Session target discovery was revoked" });
      expect(observed.unregister).not.toHaveBeenCalled();
      if (fails) {
        const failure = new Error("overlapping retirement failed");
        retirement.reject(failure);
        expect(await closing).toBe(failure);
        expect(observed.unregister).not.toHaveBeenCalled();
        observed.rotate.mockResolvedValueOnce(undefined);
        await alias.close();
      } else {
        retirement.resolve();
        await closing;
      }
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve();
      retirement.resolve();
      await Promise.allSettled([discovery, closing]);
    }
  },
);

it.each(["store", "inventory"] as const)(
  "binds queued %s discovery and byte accounting to its admitted candidates",
  async (kind) => {
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
      env: {},
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
      env: {},
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
    if (!process.versions.bun) {
      expect(observed.closeResources).toHaveBeenCalledWith(
        JSON.stringify([{ path: original.physicalPath, scope: original.scope }]),
      );
    }
  },
);

function hydrateThroughWorker() {
  const root = tempDirs.make("openclaw-hydration-quarantine-cleanup-");
  fs.mkdirSync(path.join(root, "state"));
  const quarantinePath = path.join(root, "state", "openclaw-quarantine.sqlite");
  observed.quarantinePaths.add(quarantinePath);
  fs.writeFileSync(quarantinePath, "mock quarantine");
  installWorkerTransport();
  return prepareSessionTranscriptHydration({
    agentId: "main",
    sessionId: "quarantine-hydration",
    sessionKey: "agent:main:quarantine-hydration",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    env: { OPENCLAW_STATE_DIR: root },
  }).read();
}

it("hydrates after an ordinary quarantine metadata failure whose native close succeeds", async () => {
  observed.quarantineRead.mockImplementation(() => {
    throw new Error("quarantine metadata unavailable");
  });
  await expect(hydrateThroughWorker()).resolves.toMatchObject({
    kind: "full",
    snapshot: { events: [] },
  });
  expect(observed.quarantineClose).toHaveBeenCalledOnce();
  expect(observed.hydrate).toHaveBeenCalledOnce();
  expect(observed.rotate).not.toHaveBeenCalled();
});

it.each([
  { readFails: false, retirementFails: false },
  { readFails: true, retirementFails: false },
  { readFails: true, retirementFails: true },
])(
  "retains hydration quarantine cleanup custody and graph (read=$readFails, retirement=$retirementFails)",
  async ({ readFails, retirementFails }) => {
    const readFailure = new Error("quarantine metadata read failed");
    const closeFailure = Object.assign(new Error("quarantine native close failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
    });
    const stopFailure = new Error("quarantine worker retirement failed");
    if (readFails) {
      observed.quarantineRead.mockImplementation(() => {
        throw readFailure;
      });
    }
    observed.quarantineClose.mockImplementation(() => {
      throw closeFailure;
    });
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.rotate.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    let settled = false;
    const pending = hydrateThroughWorker()
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
      expect(observed.quarantineOpen.mock.results[0]?.value.isOpen).toBe(true);
      expect(observed.hydrate).not.toHaveBeenCalled();
      expect(observed.unregister).not.toHaveBeenCalled();
      if (retirementFails) {
        retirement.reject(stopFailure);
      } else {
        retirement.resolve();
      }
      const result = await pending;
      assert("error" in result);
      const failure = result.error;
      assert(failure instanceof AggregateError);
      const quarantine = retirementFails ? failure.errors[0] : failure;
      assert(quarantine instanceof AggregateError);
      expect(quarantine.name).toBe("OpenClawQuarantineReadCleanupError");
      expect(quarantine.errors).toMatchObject([
        ...(readFails ? [{ message: readFailure.message }] : []),
        { message: closeFailure.message, code: "ERR_SQLITE_ERROR", errcode: 5 },
      ]);
      expect(quarantine.cause).toBe(quarantine.errors[0]);
      expect(observed.rotate).toHaveBeenCalledOnce();
      if (retirementFails) {
        expect(failure.errors[1]).toBe(stopFailure);
        expect(failure.cause).toBe(stopFailure);
        expect(observed.unregister).not.toHaveBeenCalled();
      } else {
        expect(observed.unregister).toHaveBeenCalledOnce();
      }
    } finally {
      retirement.resolve();
      await pending;
    }
  },
);

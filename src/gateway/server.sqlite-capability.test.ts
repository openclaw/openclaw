import "../test-utils/prepare-compiled-subprocesses.js";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { startGatewayServer } from "./server.js";

const admission = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  acquireLock: vi.fn(),
}));
vi.mock("../infra/sqlite-runtime-initialize.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-runtime-initialize.js")>()),
  initializeSqliteRuntime: admission.initialize,
}));
vi.mock("../infra/gateway-lock.js", () => ({ acquireGatewayLock: admission.acquireLock }));

afterEach(() => vi.restoreAllMocks());

it("admits SQLite before ownership without eagerly constructing database schemas", async () => {
  const entered = createDeferredCore();
  const decided = createDeferredCore();
  const reachedState = new Error("state ownership reached");
  const statements = vi.spyOn(DatabaseSync.prototype, "exec");
  admission.initialize.mockImplementationOnce(() => {
    entered.resolve();
    return decided.promise;
  });
  admission.acquireLock.mockImplementationOnce(async () => {
    throw reachedState;
  });
  const starting = withDatabaseEngineSelection(
    { effectiveEngines: resolveDatabaseFamilyEngines({}) },
    () => startGatewayServer(0),
  );
  const outcome = expect(starting).rejects.toBe(reachedState);
  try {
    await Promise.race([entered.promise, starting]);
    expect(admission.acquireLock).not.toHaveBeenCalled();
  } finally {
    decided.resolve();
    await outcome;
  }
  expect(admission.acquireLock).toHaveBeenCalledOnce();
  expect(statements).not.toHaveBeenCalled();
});

import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { startGatewayServer } from "./server.js";

const admission = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  prepareSchemas: vi.fn<() => void>(),
  acquireLock: vi.fn(),
}));
vi.mock("../infra/bun-sqlite-library.js", () => ({
  initializeSqliteRuntimeCapabilities: admission.initialize,
}));
vi.mock("../state/openclaw-database-schema-contracts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-database-schema-contracts.js")>()),
  prepareOpenClawDatabaseSchemaContracts: admission.prepareSchemas,
}));
vi.mock("../infra/gateway-lock.js", () => ({ acquireGatewayLock: admission.acquireLock }));

it("admits SQLite and prepares expected schemas before public Gateway startup acquires state ownership", async () => {
  const entered = createDeferredCore();
  const decided = createDeferredCore();
  const reachedState = new Error("state ownership reached");
  const order: string[] = [];
  admission.initialize.mockImplementationOnce(() => {
    entered.resolve();
    return decided.promise;
  });
  admission.prepareSchemas.mockImplementationOnce(() => {
    order.push("schemas");
  });
  admission.acquireLock.mockImplementationOnce(async () => {
    order.push("ownership");
    throw reachedState;
  });
  const starting = startGatewayServer(0);
  const outcome = expect(starting).rejects.toBe(reachedState);
  try {
    await Promise.race([entered.promise, starting]);
    expect(admission.prepareSchemas).not.toHaveBeenCalled();
    expect(admission.acquireLock).not.toHaveBeenCalled();
  } finally {
    decided.resolve();
    await outcome;
  }
  expect(admission.prepareSchemas).toHaveBeenCalledOnce();
  expect(admission.acquireLock).toHaveBeenCalledOnce();
  expect(order).toEqual(["schemas", "ownership"]);
});

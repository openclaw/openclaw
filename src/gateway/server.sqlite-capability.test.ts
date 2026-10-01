import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { startGatewayServer } from "./server.js";

const admission = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  acquireLock: vi.fn(),
}));
vi.mock("../infra/bun-sqlite-library.js", () => ({
  initializeSqliteRuntimeCapabilities: admission.initialize,
}));
vi.mock("../infra/gateway-lock.js", () => ({ acquireGatewayLock: admission.acquireLock }));

it("admits SQLite before public Gateway startup acquires state ownership", async () => {
  const entered = createDeferredCore();
  const decided = createDeferredCore();
  const reachedState = new Error("state ownership reached");
  admission.initialize.mockImplementationOnce(() => {
    entered.resolve();
    return decided.promise;
  });
  admission.acquireLock.mockRejectedValueOnce(reachedState);
  const starting = startGatewayServer(0);
  const outcome = expect(starting).rejects.toBe(reachedState);
  try {
    await Promise.race([entered.promise, starting]);
    expect(admission.acquireLock).not.toHaveBeenCalled();
  } finally {
    decided.resolve();
    await outcome;
  }
  expect(admission.acquireLock).toHaveBeenCalledOnce();
});

import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runWorkerProcess } from "./worker-process.js";

const admission = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  run: vi.fn<() => Promise<void>>().mockResolvedValue(),
}));
vi.mock("../infra/bun-sqlite-library.js", () => ({
  initializeSqliteRuntimeCapabilities: admission.initialize,
}));
vi.mock("../logging/console.js", () => ({
  routeLogsToStderr: vi.fn(),
  enableConsoleCapture: vi.fn(),
}));
vi.mock("./worker-command.runtime.js", () => ({ runWorkerCommand: admission.run }));

it("admits SQLite before the restricted worker accepts commands", async () => {
  const entered = createDeferredCore();
  const decided = createDeferredCore();
  admission.initialize.mockImplementationOnce(() => {
    entered.resolve();
    return decided.promise;
  });
  const starting = runWorkerProcess();
  try {
    await Promise.race([entered.promise, starting]);
    expect(admission.run).not.toHaveBeenCalled();
  } finally {
    decided.resolve();
    await starting;
  }
  expect(admission.run).toHaveBeenCalledOnce();
});

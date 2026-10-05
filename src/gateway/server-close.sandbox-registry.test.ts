import "../test-utils/prepare-compiled-subprocesses.js";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { registerSandboxBackend } from "../agents/sandbox/backend.js";
import { removeSandboxContainer } from "../agents/sandbox/manage.js";
import { updateRegistry } from "../agents/sandbox/registry.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

// mock-isolation: Upstream polling is independent of sandbox removal settlement.
vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: () => ({ stop: () => Promise.resolve() }),
}));

it("joins accepted sandbox removal across scheduler cancellation after database reopen", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-sandbox-registry-close");
  const entered = createDeferred();
  const release = createDeferred();
  const parentClosed = createDeferred();
  const removeRuntime = vi.fn(async () => {});
  let closing: Promise<void> | undefined;
  let removing: Promise<void> | undefined;
  let restoreWorker: (() => void) | undefined;
  let unregisterBackend: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    await closeOpenClawStateDatabaseAsync();
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const backendId = "sandbox-close-fixture";
    const containerName = "accepted-sandbox-removal";
    unregisterBackend = registerSandboxBackend(backendId, {
      reserveRuntimeId: () => containerName,
      factory: async () => {
        throw new Error("Removal must not provision a backend");
      },
      manager: {
        describeRuntime: async () => ({ running: false, configLabelMatch: true }),
        removeRuntime,
      },
    });
    await updateRegistry({
      containerName,
      backendId,
      sessionKey: "agent:main:sandbox-close",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "synthetic-image",
      runtimeState: "ready",
    });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    let acceptedSignal: AbortSignal | undefined;
    let paused = false;
    const run = stateWorker.runOpenClawStateWorkerOperation;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "sandboxRegistry.beginRemoval" && !paused) {
                  paused = true;
                  acceptedSignal = getAsyncWorkSignal();
                  entered.resolve();
                  await release.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
      );
    restoreWorker = () => worker.mockRestore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "accepted-sandbox-removal",
      delayMs: 0,
      async run() {
        removing = removeSandboxContainer(containerName);
        await removing;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        expectDefined(removing, "Accepted sandbox removal"),
        "Sandbox removal settled before its worker command",
      ),
      signal,
    );
    expect(acceptedSignal?.aborted).toBe(false);
    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), { once: true });
    closing = server.close({ reason: "sandbox registry settlement regression" });
    await withinTest(
      awaitGateBeforeSettlement(
        parentClosed.promise,
        closing,
        "Gateway closed before scheduler cancellation",
      ),
      signal,
    );
    expect(acceptedSignal?.aborted).toBe(false);
    expect(shared.isOpen).toBe(true);
    expect(removeRuntime).not.toHaveBeenCalled();
    await expect(removeSandboxContainer(containerName)).rejects.toThrow(
      "Sandbox registry admission is closed",
    );
    release.resolve();
    await withinTest(Promise.all([removing, closing]), signal);
    expect(removeRuntime).toHaveBeenCalledOnce();
    expect(shared.isOpen).toBe(false);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      expect(database.prepare("SELECT container_name FROM sandbox_registry_entries").all()).toEqual(
        [],
      );
    } finally {
      database.close();
    }
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([removing, closing]);
    restoreWorker?.();
    unregisterBackend?.();
    await fixture.cleanup();
  }
});

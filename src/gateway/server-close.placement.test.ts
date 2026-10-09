import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

it("settles accepted placement retirement across the close prelude before shared-state teardown", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-placement-close");
  const retirementEntered = createDeferred();
  const releaseRetirement = createDeferred();
  const preludeEntered = createDeferred();
  let retiring: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let restoreRetirement: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const database = openOpenClawStateDatabase({ env: fixture.state.env });
    const placements = kernel.sdkResourceHost.run(() =>
      createWorkerSessionPlacementStore({ database }),
    );
    const requested = await kernel.sdkResourceHost.run(() =>
      placements.startDispatch({
        sessionId: "accepted-close-placement",
        sessionKey: "agent:main:accepted-close-placement",
        agentId: "main",
      }),
    );
    let acceptedSignal: AbortSignal | undefined;
    let retirementDispatches = 0;
    const run = stateWorker.runOpenClawStateWorkerOperation;
    const recording = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "workerPlacements.retire") {
                  retirementDispatches++;
                  acceptedSignal = getAsyncWorkSignal();
                  retirementEntered.resolve();
                  await releaseRetirement.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
      );
    restoreRetirement = () => recording.mockRestore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.sdkResourceHost.run(() =>
      kernel.scheduler.schedule({
        id: "placement-close-proof",
        delayMs: 0,
        run: () => {
          retiring = placements.retireSessionPlacementAsync({
            sessionId: requested.sessionId,
            expectedState: "requested",
            expectedGeneration: requested.generation,
          });
          return retiring;
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await withinTest(retirementEntered.promise, signal);
    expect(acceptedSignal?.aborted).toBe(false);
    kernel.scheduler.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    let closed = false;
    closing = server.close({ reason: "placement retirement close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(preludeEntered.promise, closing, "Gateway skipped close prelude"),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(acceptedSignal?.aborted).toBe(false);
    expect(database.db.isOpen).toBe(true);
    expect(closed).toBe(false);

    releaseRetirement.resolve();
    await withinTest(Promise.all([retiring, closing]), signal);
    expect(retirementDispatches).toBe(1);
    expect(database.db.isOpen).toBe(false);
    vi.useRealTimers();
    const persisted = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      expect(
        persisted
          .prepare("SELECT session_id FROM worker_session_placements WHERE session_id = ?")
          .get(requested.sessionId),
      ).toBeUndefined();
    } finally {
      persisted.close();
    }
  } finally {
    vi.useRealTimers();
    releaseRetirement.resolve();
    await Promise.allSettled([retiring, closing]);
    restoreRetirement?.();
    await fixture.cleanup();
  }
});

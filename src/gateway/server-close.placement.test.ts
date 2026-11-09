import { expect, it, vi } from "vitest";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

it("settles accepted placement retirement across the close prelude before shared-state teardown", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-placement-close", signal);
  const { fixture, kernel } = race;
  let retiring: Promise<void> | undefined;
  race.onCleanup(async () => {
    await Promise.allSettled([retiring]);
  });
  try {
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
    const recording = probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (command.type === "workerPlacements.retire") {
        retirementDispatches++;
        acceptedSignal = getAsyncWorkSignal();
        await race.block();
      }
      return scope.execute(command, executeOptions);
    });
    race.onCleanup(() => recording.mockRestore());
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
    await race.waitForEntry(retiring);
    expect(acceptedSignal?.aborted).toBe(false);
    await race.close(kernel.scheduler.signal, undefined, { reason: "placement close" });
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(acceptedSignal?.aborted).toBe(false);
    expect(database.db.isOpen).toBe(true);
    expect(race.closed).toBe(false);

    await race.finish(retiring);
    expect(retirementDispatches).toBe(1);
    expect(database.db.isOpen).toBe(false);
    vi.useRealTimers();
    expect(
      readClosedDatabase(
        resolveOpenClawStateSqlitePath(fixture.state.env),
        "SELECT session_id FROM worker_session_placements WHERE session_id = ?",
        requested.sessionId,
      ),
    ).toEqual([]);
  } finally {
    vi.useRealTimers();
    await race.dispose();
  }
});

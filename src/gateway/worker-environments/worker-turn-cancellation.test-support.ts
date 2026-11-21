import { expect } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../../test/helpers/promise.js";

export type WorkerFixtureCancellationProbe = {
  pause: () => Promise<void>;
  onCleanup: () => void;
};

/** Exercise the real fixture's finally while its intended assertion gate cannot be reached. */
export async function expectWorkerFixtureCancellation(
  run: (signal: AbortSignal, probe: WorkerFixtureCancellationProbe) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const abort = new AbortController();
  const entered = createDeferred();
  const release = createDeferred();
  const reason = new Error("synthetic test cancellation");
  let cleanupStarted = false;
  const body = run(AbortSignal.any([signal, abort.signal]), {
    pause: async () => {
      entered.resolve();
      await release.promise;
    },
    onCleanup: () => {
      cleanupStarted = true;
      release.resolve();
    },
  });
  const outcome = body.catch((error: unknown) => error);
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        body,
        "Fixture settled before workspace preparation",
      ),
      signal,
    );
    abort.abort(reason);
    // Drain abort reactions without a wall-clock timeout or releasing the stalled producer.
    await nextEventLoopTurn();
    expect(
      cleanupStarted,
      "cancelled fixture must enter finally before its producer is released",
    ).toBe(true);
    expect(await withinTest(outcome, signal)).toBe(reason);
  } finally {
    // A red regression must still release and join its actual owner, never poison the next case.
    release.resolve();
    await outcome;
  }
}

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { usePlacementStoreFixture } from "./placement-store-fixture.test-support.js";

const fixture = usePlacementStoreFixture();
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(clearRuntimeConfigSnapshot);

function fail(generation: number, recoveryError = "worker disappeared") {
  return fixture.store.fail({
    sessionId: REQUEST.sessionId,
    expectedGeneration: generation,
    recoveryError,
  });
}
const claimLocal = (stage: string) =>
  fixture.store.claimTurn({
    ...REQUEST,
    owner: { kind: "local" },
    claimId: `${stage}-local-turn`,
    runId: `${stage}-local-run`,
  });
const recoverRequest = (expectedGeneration: number) => ({
  ...REQUEST,
  recoverToGateway: { expectedGeneration },
});

it.each([false, true])(
  "prepares the Gateway workspace before local admission only for explicit recovery (recover=%s)",
  async (recover) => {
    const { database, store } = fixture;
    const prepare = vi.fn(async ({ assertCurrent }: { assertCurrent: () => void }) => {
      assertCurrent();
      expect(store.get(REQUEST.sessionId)?.state).toBe("failed");
      await expect(claimLocal("premature")).rejects.toThrow();
    });
    const harness = await createHarness(database, store, { prepareGatewayMove: prepare });
    const failed = await fail((await store.startDispatch(REQUEST)).generation);

    await expect(
      harness.service.reclaim(recover ? recoverRequest(failed.generation) : REQUEST),
    ).resolves.toMatchObject({ state: "local", recoveryError: null, terminalReason: null });

    expect(prepare).toHaveBeenCalledTimes(Number(recover));
    await store.releaseTurn(await claimLocal("recovered"));
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
  },
);

it.each([
  ["stale source", "changed before Gateway recovery", 0],
  ["pending cleanup", "cleanup is still pending", 0],
  ["restore failure", "accepted checkpoint unavailable", 1],
  ["revoked authorization", "session participation changed", 1],
  ["replaced placement", "changed before Gateway recovery", 1],
] as const)("keeps local recovery closed after %s", async (failure, error, preparations) => {
  const { database, store } = fixture;
  let authorized = true;
  const authorize = () => {
    if (!authorized) {
      throw new Error("session participation changed");
    }
  };
  const prepare = vi.fn(async () => {
    if (failure === "restore failure") {
      throw new Error("accepted checkpoint unavailable");
    }
    if (failure === "revoked authorization") {
      authorized = false;
    }
    if (failure === "replaced placement") {
      await fail((await store.startDispatch(REQUEST)).generation, "replacement worker failed");
    }
  });
  const harness = await createHarness(database, store, { prepareGatewayMove: prepare });
  const requested =
    failure === "pending cleanup"
      ? await harness.placements.seedStarting()
      : await store.startDispatch(REQUEST);
  const failed = await fail(requested.generation);

  await expect(
    harness.service.reclaim(
      recoverRequest(failed.generation - (failure === "stale source" ? 1 : 0)),
      authorize,
    ),
  ).rejects.toThrow(error);

  expect(store.get(REQUEST.sessionId)?.state).toBe("failed");
  expect(prepare).toHaveBeenCalledTimes(preparations);
  expect(harness.environments.destroy).not.toHaveBeenCalled();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { usePlacementStoreFixture } from "./placement-store-fixture.test-support.js";

describe("failed placement Gateway recovery", () => {
  const fixture = usePlacementStoreFixture();
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(clearRuntimeConfigSnapshot);

  async function fail(
    requested: Awaited<ReturnType<PlacementStore["startDispatch"]>>,
    recoveryError = "worker disappeared",
  ) {
    return fixture.store.fail({
      sessionId: REQUEST.sessionId,
      expectedGeneration: requested.generation,
      recoveryError,
    });
  }

  it.each([false, true])(
    "prepares the Gateway workspace before local admission only for explicit recovery (recover=%s)",
    async (recover) => {
      const { database, store: placementStore } = fixture;
      const prepareGatewayMove = vi.fn(async ({ assertCurrent }: { assertCurrent: () => void }) => {
        assertCurrent();
        expect(placementStore.get(REQUEST.sessionId)?.state).toBe("failed");
        await expect(
          placementStore.claimTurn({
            ...REQUEST,
            owner: { kind: "local" },
            claimId: "premature-local-turn",
            runId: "premature-local-run",
          }),
        ).rejects.toThrow();
      });
      const harness = await createHarness(database, placementStore, { prepareGatewayMove });
      const failed = await fail(await placementStore.startDispatch(REQUEST));

      await expect(
        harness.service.reclaim({
          ...REQUEST,
          ...(recover ? { recoverToGateway: { expectedGeneration: failed.generation } } : {}),
        }),
      ).resolves.toMatchObject({ state: "local", recoveryError: null, terminalReason: null });

      expect(prepareGatewayMove).toHaveBeenCalledTimes(recover ? 1 : 0);
      if (recover) {
        expect(prepareGatewayMove).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: REQUEST.sessionId,
            sessionKey: REQUEST.sessionKey,
            agentId: REQUEST.agentId,
            assertCurrent: expect.any(Function),
          }),
        );
      }
      const localTurn = await placementStore.claimTurn({
        ...REQUEST,
        owner: { kind: "local" },
        claimId: "recovered-local-turn",
        runId: "recovered-local-run",
      });
      await placementStore.releaseTurn(localTurn);
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
    const { database, store: placementStore } = fixture;
    let authorized = true;
    const authorize = () => {
      if (!authorized) {
        throw new Error("session participation changed");
      }
    };
    const prepareGatewayMove = vi.fn(async () => {
      if (failure === "restore failure") {
        throw new Error("accepted checkpoint unavailable");
      }
      if (failure === "revoked authorization") {
        authorized = false;
      }
      if (failure === "replaced placement") {
        await fail(await placementStore.startDispatch(REQUEST), "replacement worker failed");
      }
    });
    const harness = await createHarness(database, placementStore, { prepareGatewayMove });
    const requested =
      failure === "pending cleanup"
        ? await harness.placements.seedStarting()
        : await placementStore.startDispatch(REQUEST);
    const failed = await fail(requested);

    await expect(
      harness.service.reclaim(
        {
          ...REQUEST,
          recoverToGateway: {
            expectedGeneration: failed.generation - (failure === "stale source" ? 1 : 0),
          },
        },
        authorize,
      ),
    ).rejects.toThrow(error);

    expect(placementStore.get(REQUEST.sessionId)?.state).toBe("failed");
    expect(prepareGatewayMove).toHaveBeenCalledTimes(preparations);
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });
});

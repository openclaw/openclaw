import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("failed placement Gateway recovery", () => {
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(() => {
    const root = tempDirs.make("openclaw-gateway-recovery-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([false, true])(
    "prepares the Gateway workspace before local admission only for explicit recovery (recover=%s)",
    async (recover) => {
      const prepareGatewayMove = vi.fn(async ({ assertCurrent }: { assertCurrent: () => void }) => {
        assertCurrent();
        expect(placementStore.get(REQUEST.sessionId)?.state).toBe("failed");
        expect(() =>
          placementStore.claimTurn({
            ...REQUEST,
            owner: { kind: "local" },
            claimId: "premature-local-turn",
            runId: "premature-local-run",
          }),
        ).toThrow();
      });
      const harness = createHarness(database, placementStore, { prepareGatewayMove });
      const requested = placementStore.startDispatch(REQUEST);
      const failed = placementStore.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "worker disappeared",
      });

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
      const localTurn = placementStore.claimTurn({
        ...REQUEST,
        owner: { kind: "local" },
        claimId: "recovered-local-turn",
        runId: "recovered-local-run",
      });
      placementStore.releaseTurn(localTurn);
      expect(harness.environments.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    "stale source",
    "pending cleanup",
    "restore failure",
    "revoked authorization",
    "replaced placement",
  ])("keeps local recovery closed after %s", async (failure) => {
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
        const replacement = placementStore.startDispatch(REQUEST);
        placementStore.fail({
          sessionId: REQUEST.sessionId,
          expectedGeneration: replacement.generation,
          recoveryError: "replacement worker failed",
        });
      }
    });
    const harness = createHarness(database, placementStore, { prepareGatewayMove });
    const requested =
      failure === "pending cleanup"
        ? harness.placements.seedStarting()
        : placementStore.startDispatch(REQUEST);
    const failed = placementStore.fail({
      sessionId: REQUEST.sessionId,
      expectedGeneration: requested.generation,
      recoveryError: "worker disappeared",
    });

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
    ).rejects.toThrow(
      failure === "restore failure"
        ? "accepted checkpoint unavailable"
        : failure === "revoked authorization"
          ? "session participation changed"
          : failure === "pending cleanup"
            ? "cleanup is still pending"
            : "changed before Gateway recovery",
    );

    expect(placementStore.get(REQUEST.sessionId)?.state).toBe("failed");
    expect(prepareGatewayMove).toHaveBeenCalledTimes(
      failure === "stale source" || failure === "pending cleanup" ? 0 : 1,
    );
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });
});

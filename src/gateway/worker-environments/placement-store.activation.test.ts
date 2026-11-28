import { beforeEach, describe, expect, it } from "vitest";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { REQUEST as SESSION, seedStartingPlacement } from "./placement-dispatch-test-fixtures.js";
import { placementTurnOwner } from "./placement-record.js";
import { usePlacementStoreFixture } from "./placement-store-fixture.test-support.js";
import { placementTransition } from "./placement-suite.test-support.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

describe("worker session placement activation", () => {
  const h = usePlacementStoreFixture();
  let environments: WorkerEnvironmentStore;
  beforeEach(async () => {
    environments = await createWorkerEnvironmentStore({ database: h.database, now: () => h.nowMs });
  });

  function createAttachedEnvironment() {
    const environmentId = `environment-${SESSION.sessionId}`;
    seedAttachedPlacementEnvironment(h.database, {
      environmentId,
      sessionId: SESSION.sessionId,
      ownerEpoch: 7,
    });
    const environment = environments.get(environmentId);
    if (!environment) {
      throw new Error("expected attached fixture environment");
    }
    return environment;
  }

  const advanceToStarting = () =>
    seedStartingPlacement(h.store, `environment-${SESSION.sessionId}`);

  async function activate(
    placement: Awaited<ReturnType<typeof advanceToStarting>>,
    ownerEpoch: number,
  ) {
    const active = await h.store.transition({
      sessionId: placement.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: ownerEpoch },
    });
    if (active.state !== "active") {
      throw new Error("expected active worker placement");
    }
    return active;
  }

  it.each(["epoch", "closing"])(
    "rolls back activation when the attached environment %s does not match",
    async (mismatch) => {
      const environment = createAttachedEnvironment();
      const starting = await advanceToStarting();
      const ownerEpoch = environment.ownerEpoch;
      if (mismatch === "closing") {
        await environments.requestDestroy({
          environmentId: environment.environmentId,
          state: "attached",
        });
      }
      const environmentRow = () =>
        h.database.db
          .prepare("SELECT * FROM worker_environments WHERE environment_id = ?")
          .get(environment.environmentId);
      const before = environmentRow();
      h.nowMs = 2_000;

      await expect(
        activate(starting, ownerEpoch + (mismatch === "epoch" ? 1 : 0)),
      ).rejects.toThrow();
      expect(h.store.get(SESSION.sessionId)).toEqual(starting);
      expect(environmentRow()).toEqual(before);
    },
  );

  it("retains activation time through claims, adoption, failure and retirement", async () => {
    const environment = createAttachedEnvironment();
    const starting = await advanceToStarting();
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBeNull();
    h.nowMs = 5_000;
    const active = await activate(starting, environment.ownerEpoch);
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
    h.nowMs = 6_000;
    const owner = placementTransition(active);
    const claim = await h.store.claimTurn({
      ...SESSION,
      owner: placementTurnOwner(active),
      claimId: "activation-claim",
      runId: "activation-run",
    });
    await h.store.releaseTurn(claim);
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);

    await closeStateDatabaseForTest();
    h.open();
    environments = await createWorkerEnvironmentStore({ database: h.database, now: () => h.nowMs });
    h.nowMs = 7_000;
    await h.store.adoptActive(owner);
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
    const draining = await h.store.startDrain(owner);
    const reconciling = await h.store.startReconcile({
      ...owner,
      expectedGeneration: draining.generation,
    });
    const failed = await h.store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: "workspace recovery failed",
    });
    h.nowMs = 8_000;
    await h.store.retireSessionPlacementAsync({
      sessionId: SESSION.sessionId,
      expectedState: "failed",
      expectedGeneration: failed.generation,
    });
    expect(h.store.get(SESSION.sessionId)).toBeUndefined();
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
  });
});

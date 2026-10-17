import { beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { REQUEST as SESSION, seedStartingPlacement } from "./placement-dispatch-test-fixtures.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

describe("worker session placement activation", () => {
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let environments: WorkerEnvironmentStore;
  let nowMs: number;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-placement-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    environments = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  function createAttachedEnvironment() {
    const environmentId = `environment-${SESSION.sessionId}`;
    seedAttachedPlacementEnvironment(database, {
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

  const advanceToStarting = () => seedStartingPlacement(store, `environment-${SESSION.sessionId}`);

  async function activate(
    placement: Awaited<ReturnType<typeof advanceToStarting>>,
    ownerEpoch: number,
  ) {
    const active = await store.transition({
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
        database.db
          .prepare("SELECT * FROM worker_environments WHERE environment_id = ?")
          .get(environment.environmentId);
      const before = environmentRow();
      nowMs = 2_000;

      await expect(
        activate(starting, ownerEpoch + (mismatch === "epoch" ? 1 : 0)),
      ).rejects.toThrow();
      expect(store.get(SESSION.sessionId)).toEqual(starting);
      expect(environmentRow()).toEqual(before);
    },
  );

  it("retains activation time through claims, adoption, failure and retirement", async () => {
    const environment = createAttachedEnvironment();
    const starting = await advanceToStarting();
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBeNull();
    nowMs = 5_000;
    const active = await activate(starting, environment.ownerEpoch);
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
    nowMs = 6_000;
    const owner = {
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    };
    const claim = await store.claimTurn({
      ...SESSION,
      owner: { kind: "worker", ...owner },
      claimId: "activation-claim",
      runId: "activation-run",
    });
    await store.releaseTurn(claim);
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    environments = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    nowMs = 7_000;
    await store.adoptActive({
      sessionId: SESSION.sessionId,
      ...owner,
      expectedGeneration: active.generation,
    });
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
    const draining = await store.startDrain({
      sessionId: SESSION.sessionId,
      ...owner,
      expectedGeneration: active.generation,
    });
    const reconciling = await store.startReconcile({
      sessionId: SESSION.sessionId,
      ...owner,
      expectedGeneration: draining.generation,
    });
    const failed = await store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: "workspace recovery failed",
    });
    nowMs = 8_000;
    await store.retireSessionPlacementAsync({
      sessionId: SESSION.sessionId,
      expectedState: "failed",
      expectedGeneration: failed.generation,
    });
    expect(store.get(SESSION.sessionId)).toBeUndefined();
    expect(environments.get(environment.environmentId)?.lastActivatedAtMs).toBe(5_000);
  });
});

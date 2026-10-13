import { beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { hashWorkerCredential } from "./credential.js";
import type {
  WorkerSessionPlacementIdentity,
  WorkerPlacementExecutionMode,
} from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement",
  agentId: "main",
  sessionKey: "agent:main:placement",
};

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

  async function attachEnvironment(
    environmentId: string,
    sessionId: string,
    from: "ready" | "idle" = "ready",
  ) {
    return await environments.transition({
      environmentId,
      from,
      to: "attached",
      patch: {
        attachedSessionIds: [sessionId],
        credential: {
          credentialHash: hashWorkerCredential(`${environmentId}:${sessionId}:${nowMs}`),
          sessionId,
          rpcSetVersion: 1,
          expiresAtMs: nowMs + 10_000,
        },
      },
    });
  }

  async function createAttachedEnvironment(identity: WorkerSessionPlacementIdentity = SESSION) {
    const environmentId = `environment-${identity.sessionId}`;
    await environments.createIntent({
      environmentId,
      providerId: "test-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: {} },
      provisionOperationId: `provision:${environmentId}`,
    });
    await environments.transition({ environmentId, from: "requested", to: "provisioning" });
    await environments.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: `lease:${environmentId}`,
        nodeDeviceId: `node:${environmentId}`,
        bootstrapReceipt: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.9.1",
          protocolFeatures: ["worker-execution-context-v2"],
        },
        credential: {
          credentialHash: hashWorkerCredential(`ready:${environmentId}`),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: nowMs + 10_000,
        },
      },
    });
    return attachEnvironment(environmentId, identity.sessionId);
  }

  async function advanceToStarting(
    identity: WorkerSessionPlacementIdentity = SESSION,
    executionMode: WorkerPlacementExecutionMode = "worker-turn",
    environmentId = `environment-${identity.sessionId}`,
  ) {
    let placement = await store.startDispatch({ ...identity, executionMode });
    placement = await store.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId },
    });
    placement = await store.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    return store.transition({
      sessionId: identity.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: `/workspace/${identity.sessionId}`,
      },
    });
  }

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
      const environment = await createAttachedEnvironment();
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
    const environment = await createAttachedEnvironment();
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

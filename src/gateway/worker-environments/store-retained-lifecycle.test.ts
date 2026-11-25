import { expect, it } from "vitest";
import type {
  WorkerRetentionObservation,
  WorkerRetentionOperation,
} from "../../plugins/worker-retention.types.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { workerReadyPatch } from "./store.test-support.js";

const directories = useStateDatabaseTempDirs();
const intent = {
  environmentId: "retained-worker",
  providerId: "provider",
  profileId: "profile",
  profileSnapshot: { settings: {} },
  provisionOperationId: "provision-original",
  retention: { version: 1 as const, ownerBinding: "session-original", computeWindowSeconds: 600 },
};
const receipt = {
  version: 1 as const,
  leaseId: "lease-original",
  identity: { diskId: "disk-original" },
};
const observation: WorkerRetentionObservation = {
  claimRevision: "revision-1",
  state: "running",
  computeExpiresAtMs: 601_000,
};
const pause: WorkerRetentionOperation = {
  id: "pause-original",
  action: "pause",
  expectedClaimRevision: "revision-1",
};
async function fixture() {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("worker-retained-lifecycle-") } };
  const open = () =>
    createWorkerEnvironmentStore({
      database: openOpenClawStateDatabase(options),
      now: () => 1_000,
    });
  let store = await open();
  const current = () => store.get(intent.environmentId)!;
  const owner = () => ({
    environmentId: intent.environmentId,
    expectedOwnerEpoch: current().ownerEpoch,
  });
  return {
    get store() {
      return store;
    },
    current,
    owner,
    async reopen() {
      await closeOpenClawStateDatabaseAsync();
      store = await open();
    },
    async allocate(withReceipt = true) {
      await store.transition({
        environmentId: intent.environmentId,
        from: "requested",
        to: "provisioning",
      });
      if (withReceipt) {
        await store.recordResourceReceipt({
          environmentId: intent.environmentId,
          provisionOperationId: intent.provisionOperationId,
          receipt,
          assertCurrent: () => {},
        });
      }
      await store.transition({
        environmentId: intent.environmentId,
        from: "provisioning",
        to: "ready",
        patch: workerReadyPatch(receipt.leaseId, "node-original"),
      });
    },
  };
}

it("persists immutable acquisition policy before allocation and fences retention admission", async () => {
  const f = await fixture();
  const created = await f.store.createIntent(intent);
  expect(created).toMatchObject({
    leaseId: null,
    resourceReceipt: null,
    retention: { policy: intent.retention, operation: null, observation: null },
  });
  await f.reopen();
  expect(await f.store.createIntent({ ...intent })).toEqual(created);
  for (const retention of [
    undefined,
    { ...intent.retention, computeWindowSeconds: 601 },
    { ...intent.retention, ownerBinding: "another-session" },
  ]) {
    await expect(f.store.createIntent({ ...intent, retention })).rejects.toThrow(
      "retention policy is immutable",
    );
  }
  await expect(
    f.store.createIntent({ ...intent, provisionOperationId: "another-provision" }),
  ).rejects.toThrow("intent binding changed");
  await f.store.recordRetentionObservation({ ...f.owner(), observation });
  await expect(f.store.beginRetentionOperation({ ...f.owner(), operation: pause })).rejects.toThrow(
    "exact resource receipt lease",
  );
  await f.allocate(false);
  await expect(f.store.beginRetentionOperation({ ...f.owner(), operation: pause })).rejects.toThrow(
    "exact resource receipt lease",
  );
  await f.store.recordResourceReceipt({
    environmentId: intent.environmentId,
    provisionOperationId: intent.provisionOperationId,
    receipt,
    assertCurrent: () => {},
  });
  const before = f.current();
  await expect(
    f.store.beginRetentionOperation({
      ...f.owner(),
      expectedOwnerEpoch: before.ownerEpoch + 1,
      operation: pause,
    }),
  ).rejects.toThrow("owner epoch changed");
  await expect(
    f.store.recordRetentionObservation({
      ...f.owner(),
      expectedOwnerEpoch: before.ownerEpoch + 1,
      observation,
    }),
  ).rejects.toThrow("owner epoch changed");
  await expect(
    f.store.beginRetentionOperation({
      ...f.owner(),
      operation: { ...pause, expectedClaimRevision: "stale-revision" },
    }),
  ).rejects.toThrow("claim revision changed");
  const denied = () => {
    throw new Error("retention authority revoked");
  };
  await expect(
    f.store.beginRetentionOperation({ ...f.owner(), operation: pause, assertCurrent: denied }),
  ).rejects.toThrow("retention authority revoked");
  await expect(
    f.store.recordRetentionObservation({ ...f.owner(), observation, assertCurrent: denied }),
  ).rejects.toThrow("retention authority revoked");
  expect(f.current()).toEqual(before);
  const unretained = await f.store.createIntent({
    ...intent,
    environmentId: "unretained",
    provisionOperationId: "unretained-provision",
    retention: undefined,
  });
  await expect(
    f.store.beginRetentionOperation({
      environmentId: unretained.environmentId,
      expectedOwnerEpoch: 0,
      operation: pause,
    }),
  ).rejects.toThrow("policy");
  await expect(
    f.store.createIntent({
      ...intent,
      environmentId: "unretained",
      provisionOperationId: "unretained-provision",
    }),
  ).rejects.toThrow("retention policy is immutable");
});

it("reopens pending operations and settles only exact observed desired-state receipts", async () => {
  const f = await fixture();
  await f.store.createIntent(intent);
  await f.allocate();
  await f.store.recordRetentionObservation({ ...f.owner(), observation });
  const pending = await f.store.beginRetentionOperation({ ...f.owner(), operation: pause });
  await f.reopen();
  expect(f.current()).toEqual(pending);
  expect(await f.store.beginRetentionOperation({ ...f.owner(), operation: { ...pause } })).toEqual(
    pending,
  );
  for (const operation of [
    { ...pause, id: "competing" },
    { ...pause, action: "resume" as const },
    { ...pause, expectedClaimRevision: "another-revision" },
  ]) {
    await expect(f.store.beginRetentionOperation({ ...f.owner(), operation })).rejects.toThrow(
      "already pending",
    );
  }
  const observed = { ...pause, phase: "observed" as const };
  const suspended: WorkerRetentionObservation = {
    ...observation,
    state: "suspended",
    claimRevision: "revision-2",
    operation: observed,
  };
  const uncertain: WorkerRetentionObservation[] = [
    { ...suspended, operation: undefined },
    { ...suspended, operation: { ...observed, id: "another-operation" } },
    { ...suspended, operation: { ...observed, action: "resume" } },
    { ...suspended, operation: { ...observed, expectedClaimRevision: "another-revision" } },
    { ...suspended, operation: { ...observed, phase: "pending" } },
    { ...suspended, state: "running" },
    { ...suspended, state: "transitioning" },
    { ...suspended, state: "unavailable" },
    { ...suspended, state: "expired" },
  ];
  for (const value of uncertain) {
    const recorded = await f.store.recordRetentionObservation({ ...f.owner(), observation: value });
    expect(recorded.retention).toEqual({
      policy: intent.retention,
      runtimeReady: false,
      operation: pause,
      observation: value,
    });
  }
  await f.store.recordError({
    environmentId: intent.environmentId,
    state: f.current().state,
    error: "provider transport lost after acceptance",
  });
  await f.reopen();
  expect(f.current().retention?.operation).toEqual(pause);
  expect(
    (await f.store.beginRetentionOperation({ ...f.owner(), operation: pause })).retention
      ?.operation,
  ).toEqual(pause);
  const paused = await f.store.recordRetentionObservation({ ...f.owner(), observation: suspended });
  expect(paused.retention).toEqual({
    policy: intent.retention,
    runtimeReady: false,
    operation: null,
    observation: suspended,
  });
  const resume: WorkerRetentionOperation = {
    id: "resume-original",
    action: "resume",
    expectedClaimRevision: "revision-2",
  };
  await f.store.beginRetentionOperation({ ...f.owner(), operation: resume });
  const running: WorkerRetentionObservation = {
    ...observation,
    claimRevision: "revision-3",
    operation: { ...resume, phase: "observed" },
  };
  expect(
    (
      await f.store.recordRetentionObservation({
        ...f.owner(),
        observation: { ...running, state: "suspended" },
      })
    ).retention?.operation,
  ).toEqual(resume);
  expect(
    (await f.store.recordRetentionObservation({ ...f.owner(), observation: running })).retention
      ?.operation,
  ).toBeNull();
  const nextPause = { ...pause, id: "pause-next", expectedClaimRevision: "revision-3" };
  await f.store.beginRetentionOperation({ ...f.owner(), operation: nextPause });
  await f.store.requestDestroy({ environmentId: intent.environmentId, state: f.current().state });
  await expect(
    f.store.beginRetentionOperation({ ...f.owner(), operation: nextPause }),
  ).rejects.toThrow("after destroy is requested");
  await f.store.recordRetentionObservation({
    ...f.owner(),
    observation: { ...running, state: "expired" },
  });
  await f.reopen();
  expect(f.current()).toMatchObject({
    state: "ready",
    leaseId: receipt.leaseId,
    destroyRequestedAtMs: 1_000,
    retention: { policy: intent.retention, operation: nextPause },
  });
});

it("settles an observed expired resume without granting runtime admission", async () => {
  const f = await fixture();
  await f.store.createIntent(intent);
  await f.allocate();
  await f.store.recordRetentionObservation({
    ...f.owner(),
    observation: { ...observation, state: "suspended" },
  });
  const resume: WorkerRetentionOperation = { ...pause, id: "resume-expired", action: "resume" };
  await f.store.beginRetentionOperation({ ...f.owner(), operation: resume });
  await f.reopen();
  const expired = await f.store.recordRetentionObservation({
    ...f.owner(),
    observation: {
      claimRevision: "revision-expired",
      state: "expired",
      computeExpiresAtMs: 999,
      operation: { ...resume, phase: "observed" },
    },
  });
  expect(expired.retention).toMatchObject({ operation: null, runtimeReady: false });
  await expect(
    f.store.setRetentionRuntimeAdmission({
      ready: true,
      ...f.owner(),
      expectedClaimRevision: "revision-expired",
      assertCurrent() {},
    }),
  ).rejects.toThrow("current work window");
  expect(
    (
      await f.store.beginRetentionOperation({
        ...f.owner(),
        operation: {
          ...pause,
          id: "pause-expired",
          expectedClaimRevision: "revision-expired",
        },
      })
    ).retention?.operation?.action,
  ).toBe("pause");
});

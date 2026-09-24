import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { normalizeWebPushDevicePreferences } from "../infra/push-web-preferences.js";
import {
  hashWebPushEndpoint,
  upsertWebPushSubscription,
  withBoundWebPushSubscriptions,
  type BoundWebPushSubscription,
} from "../infra/push-web-store.js";
import type { upsertNativeWebPushSubscription } from "../infra/push-web-store.native.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { prepareWebPushNotificationSender } from "../infra/push-web.js";
import { SQLITE_WORKER_MAX_REQUESTS_PER_WORKER } from "../infra/sqlite-worker-broker.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseByPathAsync,
} from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createEventWebPushDelivery } from "./event-web-push.js";

type PreparedSender = Awaited<ReturnType<typeof prepareWebPushNotificationSender>>;
type WebPushCommand = {
  [Type in keyof WebPushWorkerOperations]: {
    type: Type;
    input: WebPushWorkerOperations[Type]["input"];
  };
}[keyof WebPushWorkerOperations];

const mocks = vi.hoisted(() => ({
  captureContext: vi.fn(),
  executeWorker: vi.fn(),
  runWorkerOperation: vi.fn(),
  nativeUpsert: vi.fn(),
  preparedSend: vi.fn<PreparedSender>(),
  listPairedDevices: vi.fn<() => PairedDevice[] | Promise<PairedDevice[]>>(),
  nativeDatabaseOpen: vi.fn(),
}));

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: function DatabaseSync() {
    mocks.nativeDatabaseOpen();
    throw new Error("unexpected native SQLite in pure Web Push ordering control");
  },
}));

vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: mocks.captureContext,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: mocks.executeWorker,
  runOpenClawStateWorkerOperation: mocks.runWorkerOperation,
}));
vi.mock("../infra/push-web-store.native.js", () => ({
  upsertNativeWebPushSubscription: mocks.nativeUpsert,
}));
vi.mock("../infra/push-web.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/push-web.js")>()),
  // Keep every store operation real; only the prepared provider is deferred.
  prepareWebPushNotificationSender: async () => mocks.preparedSend,
}));
vi.mock("../infra/device-pairing-worker.js", () => ({
  withCurrentDevicePairingSnapshot: async <T>(
    _stateDir: string | undefined,
    prepare: (paired: PairedDevice[]) => { start: () => T } | undefined,
  ) => {
    const read = mocks.listPairedDevices();
    return prepare(read instanceof Promise ? await read : read)?.start();
  },
}));
vi.mock("../infra/device-pairing.js", () => ({
  hasEffectivePairedDeviceRole: () => true,
}));
vi.mock("../state/user-profiles.js", () => ({
  resolveUserProfileId: (profileId: string) => profileId,
}));
vi.mock("../state/user-preferences.js", () => ({ getUserPreferences: () => ({}) }));
vi.mock("./operator-role-policy.js", () => ({
  resolveOperatorRolePolicyForProfile: () => undefined,
}));
vi.mock("./session-sharing.js", () => ({ canReceiveSessionEvent: () => true }));

beforeEach(() => vi.clearAllMocks());

function mockCapturedContext() {
  const stateDir = "/synthetic/webpush-storage-scope";
  const databasePath = `${stateDir}/openclaw.sqlite`;
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: stateDir },
    coordinatorRuntime: { directory: "/synthetic/webpush-coordinator", keepAlive: false },
    admission: {
      databasePath,
      identity: { key: `path:${databasePath}`, canonicalPath: databasePath },
      assertCurrent: () => {},
    },
  };
  mocks.captureContext.mockReturnValue(context);
  return stateDir;
}

function upsertBinding(stateDir: string, userProfileId: string, nowMs: number) {
  const endpoint = "https://push.example.test/scope";
  return upsertWebPushSubscription({
    stateDir,
    endpoint,
    endpointHash: hashWebPushEndpoint(endpoint),
    keys: { p256dh: "synthetic-p256dh", auth: "synthetic-auth" },
    binding: { deviceId: "browser-device", userProfileId },
    candidateSubscriptionId: "scope-subscription",
    nowMs,
    guard: { family: "native-compatibility", assertCurrent: () => {} },
  });
}

it.each([false, true])(
  "orders binding and pairing reads before rebinding without retaining provider work (pairing delayed: %s)",
  async (delayPairing) => {
    const stateDir = mockCapturedContext();
    const pairedDevices: PairedDevice[] = [
      {
        deviceId: "browser-device",
        publicKey: "synthetic-public-key",
        role: "operator",
        roles: ["operator"],
        approvedScopes: ["operator.read"],
        tokens: {
          operator: {
            token: "synthetic-token",
            role: "operator",
            scopes: ["operator.read"],
            createdAtMs: 1,
          },
        },
        createdAtMs: 1,
        approvedAtMs: 1,
      },
    ];
    const pairingSelected = createDeferred();
    const pairingReply = createDeferred<PairedDevice[]>();
    mocks.listPairedDevices.mockImplementation(() => {
      pairingSelected.resolve();
      return delayPairing ? pairingReply.promise : pairedDevices;
    });
    const selected = createDeferred();
    const releaseReply = createDeferred();
    const providerResult = createDeferred<Awaited<ReturnType<PreparedSender>>>();
    let current: BoundWebPushSubscription | undefined;
    let mutationSettled = false;
    let providerSettled = false;
    const order: string[] = [];
    const starts: Array<{
      subscriptions: Parameters<PreparedSender>[0]["subscriptions"];
      current: BoundWebPushSubscription;
    }> = [];
    mocks.nativeUpsert.mockImplementation(
      (params: Parameters<typeof upsertNativeWebPushSubscription>[0]) => {
        params.assertCurrent?.();
        const binding = expectDefined(params.binding, "synthetic browser binding");
        current = {
          subscriptionId: "scope-subscription",
          endpoint: params.endpoint,
          keys: { ...params.keys },
          createdAtMs: 1,
          updatedAtMs: params.nowMs,
          ...binding,
          devicePreferences: normalizeWebPushDevicePreferences({
            enabled: true,
            categories: { agentFinished: true },
          }),
        };
        order.push(`mutation:${binding.userProfileId}`);
        return current;
      },
    );
    mocks.executeWorker.mockImplementation(
      async (_context: OpenClawStateWorkerContext, command: WebPushCommand) => {
        if (command.type === "webPush.hasBoundWebPushSubscriptions") {
          return current !== undefined;
        }
        if (command.type === "webPush.listBoundWebPushSubscriptions") {
          const snapshot = structuredClone(expectDefined(current, "SELECT source binding"));
          selected.resolve();
          await releaseReply.promise;
          return [snapshot];
        }
        throw new Error(`unexpected synthetic worker command: ${command.type}`);
      },
    );
    mocks.runWorkerOperation.mockImplementation(
      async (
        captured: OpenClawStateWorkerContext,
        operation: (scope: { execute: (command: WebPushCommand) => Promise<unknown> }) => unknown,
      ) => operation({ execute: (command) => mocks.executeWorker(captured, command) }),
    );
    mocks.preparedSend.mockImplementation((params) => {
      const binding = expectDefined(current, "binding at provider start");
      starts.push({
        subscriptions: structuredClone(params.subscriptions),
        current: structuredClone(binding),
      });
      order.push(`send:${binding.userProfileId}`);
      return providerResult.promise;
    });
    void providerResult.promise.then(() => {
      providerSettled = true;
    });
    // Warm the real facade's native-module load before exposing the held worker reply.
    await upsertBinding(stateDir, "profile-a", 1);
    order.length = 0;
    const warn = vi.fn();
    const delivery = createEventWebPushDelivery({
      getRuntimeConfig: () => ({}),
      stateDir,
      log: { warn },
    });
    delivery.handleEvent("chat", { state: "final", runId: "scope-run" });
    await selected.promise;
    const mutation = upsertBinding(stateDir, "profile-b", 2).then(() => {
      mutationSettled = true;
    });
    try {
      await nextTurn();
      expect(mutationSettled, "rebinding must wait while the worker reply is held").toBe(false);
      expect(current?.userProfileId).toBe("profile-a");
      expect(starts).toEqual([]);

      releaseReply.resolve();
      await pairingSelected.promise;
      if (delayPairing) {
        await nextTurn();
        expect(mutationSettled, "rebinding must also wait while pairing authority loads").toBe(
          false,
        );
        expect(starts).toEqual([]);
        pairingReply.resolve(pairedDevices);
      }
      await nextTurn();
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        subscriptions: [{ userProfileId: "profile-a" }],
        current: { userProfileId: "profile-a" },
      });
      expect(mutationSettled, "provider completion must not retain the storage lease").toBe(true);
      expect(providerSettled).toBe(false);
      expect(current?.userProfileId).toBe("profile-b");
      expect(order).toEqual(["send:profile-a", "mutation:profile-b"]);
    } finally {
      releaseReply.resolve();
      pairingReply.resolve(pairedDevices);
      providerResult.resolve([]);
      await mutation;
      await nextTurn();
    }
    expect(mocks.nativeDatabaseOpen).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  },
);

function prepareQueuedRead(readError?: Error) {
  const stateDir = mockCapturedContext();
  const selected = createDeferred();
  const releaseReply = createDeferred();
  mocks.executeWorker.mockImplementation(
    async (_context: OpenClawStateWorkerContext, command: WebPushCommand) => {
      if (command.type !== "webPush.listBoundWebPushSubscriptions") {
        throw new Error(`unexpected synthetic worker command: ${command.type}`);
      }
      selected.resolve();
      await releaseReply.promise;
      if (readError) {
        throw readError;
      }
      return [];
    },
  );
  mocks.nativeUpsert.mockImplementation(
    (params: Parameters<typeof upsertNativeWebPushSubscription>[0]) => {
      params.assertCurrent?.();
      return {
        subscriptionId: params.candidateSubscriptionId,
        endpoint: params.endpoint,
        keys: { ...params.keys },
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
      };
    },
  );
  return { stateDir, selected, releaseReply };
}

it("rejects excess waiting work before entering storage and admits new work after settlement", async () => {
  const { stateDir, selected, releaseReply } = prepareQueuedRead();
  await upsertBinding(stateDir, "profile-a", 1);
  const read = withBoundWebPushSubscriptions(stateDir, () => ({ start: () => undefined }));
  await selected.promise;
  const queued = Array.from({ length: SQLITE_WORKER_MAX_REQUESTS_PER_WORKER - 1 }, (_, index) =>
    upsertBinding(stateDir, "profile-b", index + 2),
  );
  const overflow = upsertBinding(stateDir, "excess", SQLITE_WORKER_MAX_REQUESTS_PER_WORKER + 1);
  try {
    await expect(overflow).rejects.toMatchObject({ code: "overloaded" });
    expect(mocks.executeWorker).toHaveBeenCalledOnce();
    expect(mocks.nativeUpsert).toHaveBeenCalledOnce();
  } finally {
    releaseReply.resolve();
    await Promise.allSettled([read, ...queued, overflow]);
  }
  await expect(
    upsertBinding(stateDir, "profile-c", SQLITE_WORKER_MAX_REQUESTS_PER_WORKER + 2),
  ).resolves.toMatchObject({
    subscriptionId: "scope-subscription",
  });
  expect(mocks.nativeUpsert).toHaveBeenCalledTimes(SQLITE_WORKER_MAX_REQUESTS_PER_WORKER + 1);
  expect(mocks.nativeDatabaseOpen).not.toHaveBeenCalled();
});

it("keeps the Web Push input budget bounded independently of the database broker", async () => {
  const { stateDir, selected, releaseReply } = prepareQueuedRead();
  await upsertBinding(stateDir, "profile-a", 1);
  const read = withBoundWebPushSubscriptions(stateDir, () => ({ start: () => undefined }));
  await selected.promise;
  const profileId = "x".repeat(20 * 1024 * 1024);
  const queued = Array.from({ length: 3 }, (_, index) =>
    upsertBinding(stateDir, profileId, index + 2),
  );
  const overflow = upsertBinding(stateDir, profileId, 5);
  const refusal = overflow.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    expect(await Promise.race([refusal, nextTurn()])).toMatchObject({ code: "overloaded" });
    expect(mocks.nativeUpsert).toHaveBeenCalledOnce();
  } finally {
    releaseReply.resolve();
    await Promise.allSettled([read, ...queued, overflow]);
  }
  await expect(upsertBinding(stateDir, profileId, 6)).resolves.toMatchObject({
    subscriptionId: "scope-subscription",
  });
  expect(mocks.nativeUpsert).toHaveBeenCalledTimes(5);
  expect(mocks.nativeDatabaseOpen).not.toHaveBeenCalled();
});

it.each(["read rejection", "preparation exception"] as const)(
  "settles waiting mutations after a %s",
  async (failure) => {
    const error = new Error(`synthetic ${failure}`);
    const { stateDir, selected, releaseReply } = prepareQueuedRead(
      failure === "read rejection" ? error : undefined,
    );
    await upsertBinding(stateDir, "profile-a", 1);
    const read = withBoundWebPushSubscriptions(stateDir, () => {
      throw error;
    });
    const readResult = read.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    await selected.promise;
    let mutationSettled = false;
    const mutation = upsertBinding(stateDir, "profile-b", 2).then(() => {
      mutationSettled = true;
    });
    try {
      releaseReply.resolve();
      await expect(readResult).resolves.toBe(error);
      await nextTurn();
      expect(mutationSettled).toBe(true);
      expect(mocks.nativeUpsert).toHaveBeenCalledTimes(2);
    } finally {
      releaseReply.resolve();
      await Promise.allSettled([read, mutation]);
    }
    expect(mocks.nativeDatabaseOpen).not.toHaveBeenCalled();
  },
);

it("canonical close seals retained and new admissions and joins the held binding read", async () => {
  const { selected, releaseReply } = prepareQueuedRead();
  // Identity capture inspects missing-path ancestors; this test never creates the directory or DB.
  const stateDir = path.join(os.tmpdir(), `openclaw-webpush-close-${randomUUID()}`);
  const databasePath = path.join(stateDir, "state.sqlite");
  mocks.captureContext.mockImplementation((): OpenClawStateWorkerContext => ({
    environment: { OPENCLAW_STATE_DIR: stateDir },
    coordinatorRuntime: { directory: stateDir, keepAlive: false },
    admission: captureOpenClawStateDatabaseReadAdmission(databasePath),
  }));
  const start = vi.fn();
  const read = withBoundWebPushSubscriptions(stateDir, () => ({ start }));
  const readResult = read.then(
    () => undefined,
    (error: unknown) => error,
  );
  await selected.promise;
  const queuedMutation = upsertBinding(stateDir, "profile-b", 2);
  const mutationResult = queuedMutation.then(
    () => undefined,
    (error: unknown) => error,
  );
  let closed = false;
  const closing = closeOpenClawStateDatabaseByPathAsync(databasePath).then(() => {
    closed = true;
  });
  const postSealMutation = upsertBinding(stateDir, "profile-c", 3);
  try {
    await expect(postSealMutation).rejects.toMatchObject({
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    });
    await nextTurn();
    expect(closed, "canonical close must retain the pending SELECT owner").toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(mocks.nativeUpsert).not.toHaveBeenCalled();

    releaseReply.resolve();
    await expect(readResult).resolves.toMatchObject({
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    });
    await expect(mutationResult).resolves.toMatchObject({
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    });
    await closing;
    expect(closed).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(mocks.nativeUpsert).not.toHaveBeenCalled();
  } finally {
    releaseReply.resolve();
    await Promise.allSettled([read, queuedMutation, postSealMutation, closing]);
  }
  expect(mocks.nativeDatabaseOpen).not.toHaveBeenCalled();
});

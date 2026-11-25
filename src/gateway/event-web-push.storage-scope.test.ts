import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { normalizeWebPushDevicePreferences } from "../infra/push-web-preferences.js";
import {
  hashWebPushEndpoint,
  upsertWebPushSubscription,
  withBoundWebPushSubscriptionByEndpoint,
  withBoundWebPushSubscriptions,
  type BoundWebPushSubscription,
} from "../infra/push-web-store.js";
import type { WebPushWorkerOperations } from "../infra/push-web-store.worker-contract.js";
import type { prepareWebPushNotificationSender } from "../infra/push-web.js";
import { SQLITE_WORKER_MAX_REQUESTS_PER_WORKER } from "../infra/sqlite-worker-broker.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseByPathAsync,
} from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createEventWebPushDelivery } from "./event-web-push.js";
import { withCurrentWebPushAuthority } from "./web-push-authority.js";

type PreparedSender = Awaited<ReturnType<typeof prepareWebPushNotificationSender>>;
type WebPushCommand = SqliteWorkerCommand<WebPushWorkerOperations>;
type UpsertInput = WebPushWorkerOperations["webPush.upsertWebPushSubscription"]["input"];

const mocks = vi.hoisted(() => ({
  captureContext: vi.fn(),
  executeWorker: vi.fn(),
  workerUpsert: vi.fn(),
  preparedSend: vi.fn<PreparedSender>(),
  listPairedDevices: vi.fn<() => PairedDevice[] | Promise<PairedDevice[]>>(),
  nativeDatabaseOpen: vi.fn(),
  prepareSessionFacts: vi.fn(),
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
// mock-isolation: Exercise ordering with a synthetic worker context and no real state database.
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: mocks.executeWorker,
  runOpenClawStateWorkerOperation: async (
    captured: OpenClawStateWorkerContext,
    operation: (scope: { execute: (command: WebPushCommand) => Promise<unknown> }) => unknown,
  ) =>
    operation({
      execute: async (command) =>
        command.type === "webPush.upsertWebPushSubscription"
          ? { subscription: mocks.workerUpsert(command.input) }
          : mocks.executeWorker(captured, command),
    }),
}));
vi.mock("../infra/push-web.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/push-web.js")>()),
  // Keep every store operation real; only the prepared provider is deferred.
  prepareWebPushNotificationSender: async () => mocks.preparedSend,
}));
// mock-isolation: Hold synthetic pairing replies without starting the real SQLite worker.
vi.mock("../infra/device-pairing-worker.js", () => ({
  withCurrentDevicePairingSnapshot: async <T>(
    _stateDir: string | undefined,
    prepare: (paired: PairedDevice[]) => { start: () => T } | undefined,
    preparePublication?: () => Promise<void>,
  ) => {
    const read = mocks.listPairedDevices();
    const paired = read instanceof Promise ? await read : read;
    await preparePublication?.();
    return prepare(paired)?.start();
  },
}));
vi.mock("../infra/device-pairing.js", () => ({
  hasEffectivePairedDeviceRole: () => true,
}));
vi.mock("../state/user-profile-list.js", () => ({
  prepareUserProfileCatalog: async () => ({
    readCurrentIdentity: (profileId: string) => ({
      profileId,
      aliases: new Set([profileId]),
      role: null,
    }),
    release: () => {},
  }),
}));
vi.mock("../state/user-preferences.js", () => ({
  getUserPreferenceValues: async () => ({ values: new Map(), isCurrent: () => true }),
}));
vi.mock("./operator-role-policy.js", () => ({
  resolveOperatorRolePolicyForAssignment: () => undefined,
}));
vi.mock("./session-sharing.js", () => ({ canReceiveSessionEvent: () => true }));
vi.mock("./session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.prepareSessionFacts,
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => expect(mocks.nativeDatabaseOpen).not.toHaveBeenCalled());

function mockCapturedContext() {
  const stateDir = "/synthetic/webpush-storage-scope";
  const databasePath = `${stateDir}/openclaw.sqlite`;
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: stateDir },
    admission: {
      coordinationKey: `path:${databasePath}`,
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
  });
}

function mockStore(
  reads: Partial<
    Record<WebPushCommand["type"], (current: BoundWebPushSubscription | undefined) => unknown>
  >,
  onUpsert?: (current: BoundWebPushSubscription) => void,
  preferences?: Parameters<typeof normalizeWebPushDevicePreferences>[0],
) {
  let current: BoundWebPushSubscription | undefined;
  mocks.workerUpsert.mockImplementation((params: UpsertInput) => {
    current = {
      subscriptionId: params.candidateSubscriptionId,
      endpoint: params.endpoint,
      keys: params.keys,
      createdAtMs: 1,
      updatedAtMs: params.nowMs,
      ...expectDefined(params.binding, "synthetic browser binding"),
      devicePreferences: normalizeWebPushDevicePreferences(preferences),
    };
    onUpsert?.(current);
    return current;
  });
  mocks.executeWorker.mockImplementation(
    async (_context: OpenClawStateWorkerContext, command: WebPushCommand) => {
      const read = reads[command.type];
      if (!read) {
        throw new Error(`unexpected synthetic worker command: ${command.type}`);
      }
      return read(current);
    },
  );
  return { current: () => current };
}

function outcome(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

it("orders binding and pairing reads before rebinding without retaining provider work", async () => {
  const stateDir = mockCapturedContext();
  const scopes = ["operator.read"];
  const operator = { token: "synthetic-token", role: "operator", scopes, createdAtMs: 1 };
  const pairedDevices: PairedDevice[] = [
    {
      deviceId: "browser-device",
      publicKey: "synthetic-public-key",
      approvedScopes: scopes,
      tokens: { operator },
      createdAtMs: 1,
      approvedAtMs: 1,
    },
  ];
  const pairingSelected = createDeferred();
  const pairingReply = createDeferred<PairedDevice[]>();
  mocks.listPairedDevices.mockImplementation(() => {
    pairingSelected.resolve();
    return pairingReply.promise;
  });
  const selected = createDeferred();
  const releaseReply = createDeferred();
  const providerResult = createDeferred<Awaited<ReturnType<PreparedSender>>>();
  const providerSettled = vi.fn();
  const order: string[] = [];
  const store = mockStore(
    {
      "webPush.hasBoundWebPushSubscriptions": (current) => current !== undefined,
      "webPush.listBoundWebPushSubscriptions": async (current) => {
        const snapshot = structuredClone(expectDefined(current, "SELECT source binding"));
        selected.resolve();
        await releaseReply.promise;
        return [snapshot];
      },
    },
    (current) => order.push(`mutation:${current.userProfileId}`),
    { enabled: true, categories: { agentFinished: true } },
  );
  mocks.preparedSend.mockImplementation(() => {
    const binding = expectDefined(store.current(), "binding at provider start");
    order.push(`send:${binding.userProfileId}`);
    return providerResult.promise;
  });
  void providerResult.promise.then(providerSettled);
  // Publish the initial binding before exposing the held worker reply.
  await upsertBinding(stateDir, "profile-a", 1);
  order.length = 0;
  const warnings = createWarnLogCapture("web-push-storage-scope");
  onTestFinished(() => warnings.cleanup());
  const delivery = createEventWebPushDelivery(() => ({}));
  delivery.handleEvent("chat", { state: "final", runId: "scope-run" });
  await selected.promise;
  const mutation = upsertBinding(stateDir, "profile-b", 2);
  try {
    await nextTurn();
    expect(order).toEqual([]);

    releaseReply.resolve();
    await pairingSelected.promise;
    await nextTurn();
    expect(order).toEqual([]);
    pairingReply.resolve(pairedDevices);
    await nextTurn();
    expect(mocks.preparedSend.mock.calls[0]?.[0].subscriptions).toMatchObject([
      { userProfileId: "profile-a" },
    ]);
    expect(providerSettled).not.toHaveBeenCalled();
    expect(order).toEqual(["send:profile-a", "mutation:profile-b"]);
  } finally {
    releaseReply.resolve();
    pairingReply.resolve(pairedDevices);
    providerResult.resolve([]);
    await mutation;
    await nextTurn();
  }
  expect(await warnings.findText("event Web Push")).toBeUndefined();
});

function prepareQueuedRead(readError?: Error) {
  const stateDir = mockCapturedContext();
  const selected = createDeferred();
  const releaseReply = createDeferred();
  mockStore({
    "webPush.listBoundWebPushSubscriptions": async () => {
      selected.resolve();
      await releaseReply.promise;
      if (readError) {
        throw readError;
      }
      return [];
    },
  });
  return { stateDir, selected, releaseReply };
}

it("keeps browser storage responsive while notification session facts load", async () => {
  const stateDir = mockCapturedContext();
  const entered = createDeferred();
  const release = createDeferred();
  const provider = createDeferred();
  const factsReleased = vi.fn();
  mocks.prepareSessionFacts.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return {
      prepareRead: () => undefined,
      readCurrent: () => ({ target: null, membership: new Set<string>() }),
      release: factsReleased,
    };
  });
  mockStore({
    "webPush.listBoundWebPushSubscriptions": (current) => [current],
    "webPush.findBoundWebPushSubscriptionByEndpoint": (current) => current,
  });
  mocks.listPairedDevices.mockReturnValue([]);
  await upsertBinding(stateDir, "profile-a", 1);
  const start = vi.fn(() => provider.promise);
  const delivery = withCurrentWebPushAuthority(
    { stateDir, getRuntimeConfig: () => ({}), sessionKeys: ["agent:main:scope"] },
    (authority) => {
      expect(authority.subscriptions[0]?.userProfileId).toBe("profile-b");
      return { start };
    },
  );
  await entered.promise;
  const browserFinished = vi.fn();
  const browser = (async () => {
    await upsertBinding(stateDir, "profile-b", 2);
    await withBoundWebPushSubscriptionByEndpoint(
      { stateDir, endpoint: "https://push.example.test/scope" },
      (subscription) => ({
        start: () => expect(subscription?.userProfileId).toBe("profile-b"),
      }),
    );
    browserFinished();
  })();
  try {
    await nextTurn();
    expect(browserFinished).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    release.resolve();
    await nextTurn();
    expect(start).toHaveBeenCalledOnce();
    expect(
      factsReleased,
      "provider completion must not retain session facts",
    ).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    provider.resolve();
    await Promise.allSettled([browser, delivery]);
  }
});

it.each([
  {
    budget: "request count",
    count: SQLITE_WORKER_MAX_REQUESTS_PER_WORKER - 1,
    profile: "profile-b",
  },
  { budget: "input bytes", count: 3, profile: "x".repeat(20 * 1024 * 1024) },
])(
  "rejects excess $budget work before storage and readmits after settlement",
  async ({ count, profile }) => {
    const { stateDir, selected, releaseReply } = prepareQueuedRead();
    await upsertBinding(stateDir, "profile-a", 1);
    const read = withBoundWebPushSubscriptions(stateDir, () => ({ start: () => undefined }));
    await selected.promise;
    const queued = Array.from({ length: count }, (_, index) =>
      upsertBinding(stateDir, profile, index + 2),
    );
    const overflow = upsertBinding(stateDir, profile, count + 2);
    const refusal = outcome(overflow);
    try {
      expect(await Promise.race([refusal, nextTurn()])).toMatchObject({ code: "overloaded" });
      expect(mocks.executeWorker).toHaveBeenCalledOnce();
      expect(mocks.workerUpsert).toHaveBeenCalledOnce();
    } finally {
      releaseReply.resolve();
      await Promise.allSettled([read, ...queued, overflow]);
    }
    await expect(upsertBinding(stateDir, profile, count + 3)).resolves.toMatchObject({
      subscriptionId: "scope-subscription",
    });
    expect(mocks.workerUpsert).toHaveBeenCalledTimes(count + 2);
  },
);

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
    const readResult = outcome(read);
    await selected.promise;
    const mutationSettled = vi.fn();
    const mutation = upsertBinding(stateDir, "profile-b", 2).then(mutationSettled);
    try {
      releaseReply.resolve();
      await expect(readResult).resolves.toBe(error);
      await nextTurn();
      expect(mutationSettled).toHaveBeenCalledOnce();
      expect(mocks.workerUpsert).toHaveBeenCalledTimes(2);
    } finally {
      releaseReply.resolve();
      await Promise.allSettled([read, mutation]);
    }
  },
);

it("canonical close seals retained and new admissions and joins the held binding read", async () => {
  const { selected, releaseReply } = prepareQueuedRead();
  // Identity capture inspects missing-path ancestors; this test never creates the directory or DB.
  const stateDir = path.join(os.tmpdir(), `openclaw-webpush-close-${randomUUID()}`);
  const databasePath = path.join(stateDir, "state.sqlite");
  mocks.captureContext.mockImplementation((): OpenClawStateWorkerContext => ({
    environment: { OPENCLAW_STATE_DIR: stateDir },
    admission: captureOpenClawStateDatabaseReadAdmission(databasePath),
  }));
  const start = vi.fn();
  const read = withBoundWebPushSubscriptions(stateDir, () => ({ start }));
  const readResult = outcome(read);
  await selected.promise;
  const queuedMutation = upsertBinding(stateDir, "profile-b", 2);
  const mutationResult = outcome(queuedMutation);
  const closed = vi.fn();
  const closing = closeOpenClawStateDatabaseByPathAsync(databasePath).then(closed);
  const postSealMutation = upsertBinding(stateDir, "profile-c", 3);
  try {
    await expect(postSealMutation).rejects.toMatchObject({
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    });
    await nextTurn();
    expect(closed).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(mocks.workerUpsert).not.toHaveBeenCalled();

    releaseReply.resolve();
    await expect(readResult).resolves.toMatchObject({
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    });
    await expect(mutationResult).resolves.toMatchObject({
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    });
    await closing;
    expect(closed).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(mocks.workerUpsert).not.toHaveBeenCalled();
  } finally {
    releaseReply.resolve();
    await Promise.allSettled([read, queuedMutation, postSealMutation, closing]);
  }
});

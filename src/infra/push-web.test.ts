import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import { readConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  deleteWebPushApprovalDeliveryTargets,
  withBoundWebPushSubscriptionByEndpoint,
  hashWebPushEndpoint,
  hasBoundWebPushSubscriptions,
  withBoundWebPushSubscriptions,
  listTerminalWebPushApprovalDeliveryIds,
  listWebPushApprovalDeliveryTargets,
  listWebPushSubscriptions,
  prepareWebPushApprovalDeliveries,
  readPersistedVapidKeyPair,
  setWebPushSubscriptionPreferences,
} from "./push-web-store.js";
import { WEB_PUSH_VAPID_STATE_KEY } from "./push-web-store.records.js";
import {
  broadcastWebPush,
  clearBoundWebPushSubscription,
  prepareWebPushNotificationSender,
  registerWebPushSubscription,
  resolveVapidKeys,
} from "./push-web.js";
import { runSqliteReadOperationSync } from "./sqlite-schema-facts.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

const { webPushWarn } = vi.hoisted(() => ({ webPushWarn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/web-push" ? { ...logger, warn: webPushWarn } : logger;
    },
  };
});

let tmpDir: string;
const defaultDevicePreferences = { enabled: true, label: "" };

async function readBoundSubscriptions(stateDir: string) {
  return expectDefined(
    await withBoundWebPushSubscriptions(stateDir, (subscriptions) => ({
      start: () => subscriptions,
    })),
    "bound subscription snapshot",
  );
}

const defaultSubscriptionKeys = { p256dh: "p256dh-key", auth: "auth-key" };
const browserBinding = { deviceId: "browser-device", userProfileId: "profile-1" };
type Binding = { deviceId: string; userProfileId: string | null };
const deviceBinding = (deviceId: string, userProfileId: string | null = null): Binding => ({
  deviceId,
  userProfileId,
});
const databaseOptions = () => ({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } });
const stateDatabase = () => openOpenClawStateDatabase(databaseOptions());
const listSubscriptions = () => listWebPushSubscriptions(tmpDir);
const broadcastTitle = (title: string) => broadcastWebPush({ title }, tmpDir);
const pushUrl = (name: string) => `https://push.example.com/${name}`;
const ownerBinding = deviceBinding("owner-device", "owner-profile");

function clearSubscription(endpoint: string, binding: Binding) {
  return clearBoundWebPushSubscription({
    endpoint,
    expectedDeviceId: binding.deviceId,
    expectedUserProfileId: binding.userProfileId,
    baseDir: tmpDir,
  });
}

function prepareTargets(
  approvalId: string,
  subscriptions: Parameters<typeof prepareWebPushApprovalDeliveries>[0]["subscriptions"],
) {
  return prepareWebPushApprovalDeliveries({
    approvalId,
    subscriptions,
    preparedAtMs: 2_000,
    stateDir: tmpDir,
  });
}

function targets(approvalId: string) {
  return listWebPushApprovalDeliveryTargets({ approvalId, stateDir: tmpDir });
}

async function writeLegacy(name: string, contents = "{}") {
  const legacyPath = path.join(tmpDir, "push", name);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, contents, "utf8");
  return legacyPath;
}

type SubscriptionOverrides = Partial<
  Omit<Parameters<typeof registerWebPushSubscription>[0], "endpoint" | "baseDir">
>;

function registerSubscription(endpoint: string, overrides: SubscriptionOverrides = {}) {
  return registerWebPushSubscription({
    endpoint,
    keys: defaultSubscriptionKeys,
    ...overrides,
    baseDir: tmpDir,
  });
}

async function registerBound(endpoint: string, binding: Binding = browserBinding) {
  const subscription = await registerSubscription(endpoint, { binding });
  return { ...subscription, ...binding, devicePreferences: defaultDevicePreferences };
}

function registerTarget(device: string, profile: string | null = null) {
  return registerBound(pushUrl(device), deviceBinding(device, profile));
}

function deleteTargets(approvalId: string, subscriptionId: string) {
  return deleteWebPushApprovalDeliveryTargets({
    approvalId,
    subscriptionIds: [subscriptionId],
    stateDir: tmpDir,
  });
}

async function resolveApproval(id: string) {
  const result = await resolveOperatorApproval({
    id,
    decision: "deny",
    resolver: { kind: "system", id: null },
    nowMs: 3_000,
    databaseOptions: databaseOptions(),
  });
  expect(result.outcome).toBe("resolved");
}

function findBound(endpoint: string) {
  return withBoundWebPushSubscriptionByEndpoint({ endpoint, stateDir: tmpDir }, (subscription) => ({
    start: () => subscription,
  }));
}

function setPreferences(
  endpoint: string,
  preferences: Parameters<typeof setWebPushSubscriptionPreferences>[0]["preferences"],
  binding: Binding = browserBinding,
) {
  return setWebPushSubscriptionPreferences({
    endpoint,
    preferences,
    expectedDeviceId: binding.deviceId,
    expectedUserProfileId: binding.userProfileId,
    stateDir: tmpDir,
  });
}

async function insertPendingApproval(id: string): Promise<void> {
  const inserted = await insertOperatorApproval({
    approval: {
      id,
      kind: "exec",
      presentation: {
        kind: "exec",
        commandText: "echo approval",
        commandPreview: "echo approval",
        warningText: null,
        host: "gateway",
        nodeId: null,
        agentId: "main",
        allowedDecisions: ["allow-once", "deny"],
      },
      runtimeEpoch: "web-push-test-runtime",
      createdAtMs: 1_000,
      expiresAtMs: 60_000,
    },
    databaseOptions: databaseOptions(),
  });
  if (inserted.outcome !== "inserted") {
    throw new Error("expected pending approval insert");
  }
}
const generatedVapidKeys = vi.hoisted(() => ({
  publicKey: "test-public-key-base64url",
  privateKey: "test-private-key-base64url",
}));
vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveStateDir: () => tmpDir,
  };
});

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => generatedVapidKeys),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }),
  },
}));
const sendNotification = vi.mocked(webPush.sendNotification);
const generateVAPIDKeys = vi.mocked(webPush.generateVAPIDKeys);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-web-test-"));
  vi.clearAllMocks();
  sendNotification.mockReset().mockResolvedValue({ statusCode: 201 } as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function startExpiredWebPushBroadcast(
  payload: Parameters<typeof broadcastWebPush>[0],
  signal: AbortSignal,
) {
  const started = createDeferred();
  const release = createDeferred();
  sendNotification.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw Object.assign(new Error("gone"), { statusCode: 410 });
  });
  const broadcast = broadcastWebPush(payload, tmpDir);
  const finish = () => {
    release.resolve();
    return broadcast;
  };
  return {
    // Bind the gate to the test signal so a stall still reaches the async disposer.
    started: withinTest(
      awaitGateBeforeSettlement(
        started.promise,
        broadcast,
        "Web Push broadcast completed before send started",
      ),
      signal,
    ),
    finish,
    // Join the send before afterEach removes the real SQLite fixture, even when a case fails.
    async [Symbol.asyncDispose]() {
      await finish();
    },
  };
}

describe("resolveVapidKeys", () => {
  it("reads the durable VAPID identity while an unrelated writer is blocked", async ({
    signal,
  }) => {
    await resolveVapidKeys(tmpDir);
    await readConfigMachineStateAsync(WEB_PUSH_VAPID_STATE_KEY, databaseOptions());
    const captured = captureOpenClawStateWorkerContext(databaseOptions());
    const writerLock = new DatabaseSync(captured.admission.databasePath);
    writerLock.exec("BEGIN IMMEDIATE");
    const enqueued = createDeferred();
    const endpoint = pushUrl("held-registration");
    const writer = stateWorker.runOpenClawStateWorkerOperation(
      captured,
      (scope) =>
        scope.execute({
          type: "webPush.upsertWebPushSubscription",
          input: {
            endpoint,
            endpointHash: hashWebPushEndpoint(endpoint),
            keys: defaultSubscriptionKeys,
            candidateSubscriptionId: "held-registration",
            nowMs: 1_000,
          },
        }),
      {
        createAdmission: () => {
          enqueued.resolve();
          return {
            nativeLocations: [captured.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((_request, grant) => grant()),
          };
        },
      },
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(enqueued.promise, writer, "Writer did not reach its worker"),
        signal,
      );
      const keys = await withinTest(
        awaitGateBeforeSettlement(resolveVapidKeys(tmpDir), writer, "VAPID read waited for writer"),
        signal,
      );
      expect(keys).toEqual({
        ...generatedVapidKeys,
        subject: "https://openclaw.ai",
      });
    } finally {
      writerLock.exec("ROLLBACK");
      writerLock.close();
      await writer;
    }
  });

  it("generates one durable SQLite VAPID identity", async () => {
    const keys = await resolveVapidKeys(tmpDir);
    expect(keys).toEqual({
      ...generatedVapidKeys,
      subject: "https://openclaw.ai",
    });
    expect(await readPersistedVapidKeyPair(tmpDir)).toEqual(keys);

    await closeOpenClawStateDatabaseAsync();
    await expect(resolveVapidKeys(tmpDir)).resolves.toEqual(keys);
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(tmpDir, "push", "vapid-keys.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires Doctor before creating an identity beside retired state", async () => {
    const legacyPath = await writeLegacy("vapid-keys.json");

    await expect(resolveVapidKeys(tmpDir)).rejects.toThrow("openclaw doctor --fix");
    expect(await readPersistedVapidKeyPair(tmpDir)).toBeNull();
    expect(generateVAPIDKeys).not.toHaveBeenCalled();

    await fs.rename(legacyPath, `${legacyPath}.doctor-importing`);
    await expect(resolveVapidKeys(tmpDir)).rejects.toThrow("openclaw doctor --fix");
    expect(generateVAPIDKeys).not.toHaveBeenCalled();

    await fs.rm(`${legacyPath}.doctor-importing`);
    await fs.symlink(path.join(tmpDir, "missing-vapid-keys.json"), legacyPath);
    await expect(resolveVapidKeys(tmpDir)).rejects.toThrow("openclaw doctor --fix");
    expect(generateVAPIDKeys).not.toHaveBeenCalled();
  });

  it("converges concurrent first-use generation on the first committed identity", async () => {
    generateVAPIDKeys
      .mockReturnValueOnce({ publicKey: "public-a", privateKey: "private-a" })
      .mockReturnValueOnce({ publicKey: "public-b", privateKey: "private-b" });

    const [first, second] = await Promise.all([resolveVapidKeys(tmpDir), resolveVapidKeys(tmpDir)]);

    expect(first).toEqual(second);
    expect(await readPersistedVapidKeyPair(tmpDir)).toEqual(first);
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(2);
  });

  it("prefers a complete environment override without persisting it", async () => {
    const environmentKeys = {
      publicKey: "env-public",
      privateKey: "env-private",
      subject: "mailto:env@test.com",
    };
    vi.stubEnv("OPENCLAW_VAPID_PUBLIC_KEY", `  ${environmentKeys.publicKey}  `);
    vi.stubEnv("OPENCLAW_VAPID_PRIVATE_KEY", `  ${environmentKeys.privateKey}  `);
    vi.stubEnv("OPENCLAW_VAPID_SUBJECT", `  ${environmentKeys.subject}  `);
    await expect(resolveVapidKeys(tmpDir)).resolves.toEqual(environmentKeys);
    expect(await readPersistedVapidKeyPair(tmpDir)).toBeNull();
    expect(generateVAPIDKeys).not.toHaveBeenCalled();
  });

  it("treats blank environment values as unset", async () => {
    for (const name of [
      "OPENCLAW_VAPID_PUBLIC_KEY",
      "OPENCLAW_VAPID_PRIVATE_KEY",
      "OPENCLAW_VAPID_SUBJECT",
    ]) {
      vi.stubEnv(name, "   ");
    }
    const keys = await resolveVapidKeys(tmpDir);
    expect(keys).toEqual({
      publicKey: "test-public-key-base64url",
      privateKey: "test-private-key-base64url",
      subject: "https://openclaw.ai",
    });
    expect(await readPersistedVapidKeyPair(tmpDir)).toEqual(keys);
    expect(vi.mocked(webPush.generateVAPIDKeys)).toHaveBeenCalledTimes(1);
  });

  it("applies the current subject to a persisted identity", async () => {
    const initial = await resolveVapidKeys(tmpDir);
    vi.stubEnv("OPENCLAW_VAPID_SUBJECT", "mailto:changed@test.com");
    await expect(resolveVapidKeys(tmpDir)).resolves.toEqual({
      ...initial,
      subject: "mailto:changed@test.com",
    });
    expect((await readPersistedVapidKeyPair(tmpDir))?.subject).toBe("https://openclaw.ai");
  });
});

describe("subscription CRUD", () => {
  const endpoint = "https://push.example.com/send/abc123";

  it("registers, updates, and reopens a durable subscription", async () => {
    const first = await registerSubscription(endpoint);
    const updated = await registerSubscription(endpoint, {
      keys: { p256dh: "new-p256dh", auth: "new-auth" },
    });
    expect(updated).toMatchObject({
      subscriptionId: first.subscriptionId,
      createdAtMs: first.createdAtMs,
      endpoint,
      keys: { p256dh: "new-p256dh", auth: "new-auth" },
    });

    await closeOpenClawStateDatabaseAsync();
    expect(await listSubscriptions()).toEqual([updated]);
    await expect(fs.stat(path.join(tmpDir, "push"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lazily adds and persists authenticated device bindings", async () => {
    const database = stateDatabase();
    const columns = ["device_id", "user_profile_id", "preferences_json"];
    for (const column of columns) {
      database.db.exec(`ALTER TABLE web_push_subscriptions DROP COLUMN ${column};`);
      expect(tableHasColumn(database.db, "web_push_subscriptions", column)).toBe(false);
    }

    const subscription = await registerBound(endpoint);

    for (const column of columns) {
      expect(tableHasColumn(database.db, "web_push_subscriptions", column)).toBe(true);
    }
    expect(await readBoundSubscriptions(tmpDir)).toEqual([subscription]);
  });

  it("retains bound-subscription presence until registration or removal changes it", async () => {
    const execute = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);
    execute.mockClear();
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    await registerSubscription(endpoint);
    expect(await readBoundSubscriptions(tmpDir)).toEqual([]);
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);
    const { db } = stateDatabase();
    db.exec("UPDATE web_push_subscriptions SET device_id = ''");
    expect(await readBoundSubscriptions(tmpDir)).toEqual([]);
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);

    const binding = deviceBinding("browser-device");
    const rebound = await registerBound(endpoint, binding);
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(true);
    execute.mockClear();
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(await readBoundSubscriptions(tmpDir)).toEqual([rebound]);
    await registerSubscription(endpoint);
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);
    await registerBound(endpoint, binding);
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(true);
    expect(await clearSubscription(endpoint, binding)).toBe(true);
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);
    execute.mockClear();
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves bindings when an older writer updates only the original columns", async () => {
    const subscription = await registerBound(endpoint);
    await closeOpenClawStateDatabaseAsync();

    const olderWriter = new DatabaseSync(path.join(tmpDir, "state", "openclaw.sqlite"));
    olderWriter
      .prepare(
        "UPDATE web_push_subscriptions SET auth = ?, updated_at_ms = ? WHERE endpoint_hash = ?",
      )
      .run("older-auth", subscription.updatedAtMs + 1, hashWebPushEndpoint(endpoint));
    olderWriter.close();

    expect(await readBoundSubscriptions(tmpDir)).toEqual([
      {
        ...subscription,
        keys: { ...subscription.keys, auth: "older-auth" },
        updatedAtMs: subscription.updatedAtMs + 1,
      },
    ]);
  });

  it("persists preferences only while the authenticated subscription binding still matches", async () => {
    await registerBound(endpoint);
    const preferences = { enabled: true, label: "Slot 1", categories: { agentQuestion: true } };
    const keys = { p256dh: "refreshed-p256dh", auth: "refreshed-auth" };
    const nextBinding = deviceBinding("other-device", "profile-2");
    expect(
      await setPreferences(
        endpoint,
        { enabled: false, label: "Wrong" },
        { ...browserBinding, deviceId: "different-device" },
      ),
    ).toBe(false);
    expect(await setPreferences(endpoint, preferences)).toBe(true);
    expect(await findBound(endpoint)).toMatchObject({
      ...browserBinding,
      devicePreferences: preferences,
    });

    await registerSubscription(endpoint, { keys, binding: browserBinding });
    expect(await findBound(endpoint)).toMatchObject({
      devicePreferences: { enabled: true, label: "Slot 1" },
    });

    await registerSubscription(endpoint, { keys, binding: nextBinding });
    expect(await findBound(endpoint)).toMatchObject({
      ...nextBinding,
      devicePreferences: defaultDevicePreferences,
    });
  });

  it("preserves unrelated concurrent registrations", async () => {
    const endpoints = ["a", "b", "c"].map(pushUrl);
    await Promise.all(endpoints.map((url) => registerSubscription(url)));
    expect((await listSubscriptions()).map((entry) => entry.endpoint).toSorted()).toEqual(
      endpoints,
    );
  });

  it("clears only the matching endpoint", async () => {
    await registerSubscription(endpoint, {
      binding: { deviceId: "browser-device", userProfileId: null },
    });
    const target = {
      endpoint,
      expectedDeviceId: "browser-device",
      expectedUserProfileId: null,
      baseDir: tmpDir,
    };
    await expect(clearBoundWebPushSubscription(target)).resolves.toBe(true);
    await expect(clearBoundWebPushSubscription(target)).resolves.toBe(false);
  });

  it("rejects an endpoint-only ownership takeover without changing the subscription", async () => {
    const original = await registerSubscription(endpoint, {
      binding: ownerBinding,
    });
    await expect(
      registerSubscription(endpoint, {
        keys: { p256dh: "forged-p256dh", auth: "forged-auth" },
        binding: { deviceId: "other-device", userProfileId: "other-profile" },
      }),
    ).rejects.toThrow("existing browser subscription keys required");
    expect(await listSubscriptions()).toEqual([original]);
  });

  it.each([
    { deviceId: "other-device", userProfileId: "owner-profile" },
    { deviceId: "owner-device", userProfileId: "other-profile" },
    { deviceId: "owner-device", userProfileId: null },
  ])("fences a stale unsubscribe after rebinding to %j", async (binding) => {
    await registerBound(endpoint, ownerBinding);
    expect(await findBound(endpoint)).not.toBeNull();
    await registerBound(endpoint, binding);
    await expect(clearSubscription(endpoint, ownerBinding)).resolves.toBe(false);
    expect(await findBound(endpoint)).toMatchObject(binding);
    await expect(clearSubscription(endpoint, binding)).resolves.toBe(true);
  });

  it("rejects invalid registration data", async () => {
    await expect(registerSubscription("http://insecure.example.com")).rejects.toThrow(
      "invalid push subscription endpoint",
    );
    await expect(
      registerSubscription(endpoint, {
        keys: { p256dh: "", auth: "auth" },
      }),
    ).rejects.toThrow("invalid push subscription keys");
  });

  it("blocks an empty broadcast while retired subscriptions await Doctor", async () => {
    await writeLegacy("web-push-subscriptions.json");

    expect(await listSubscriptions()).toEqual([]);
    await expect(broadcastTitle("Blocked")).rejects.toThrow("openclaw doctor --fix");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("blocks mutations while a Doctor claim is pending", async () => {
    const existing = await registerSubscription(endpoint);
    await writeLegacy("web-push-subscriptions.json.doctor-importing");

    await expect(clearSubscription(endpoint, deviceBinding("browser-device"))).rejects.toThrow(
      "openclaw doctor --fix",
    );
    await expect(registerSubscription("https://push.example.com/new")).rejects.toThrow(
      "openclaw doctor --fix",
    );
    expect(await listSubscriptions()).toEqual([existing]);
  });
});

describe("approval delivery target persistence", () => {
  it("lazily persists successful targets across reopen until terminal replacement", async () => {
    const approvalId = "exec:restart-safe-push";
    await insertPendingApproval(approvalId);
    const first = await registerTarget("first", "profile-first");
    const second = await registerTarget("second");
    const database = stateDatabase();
    const deliveriesExist = () =>
      runSqliteReadOperationSync(database.db, () =>
        tableExists(database.db, "web_push_approval_deliveries"),
      );
    expect(deliveriesExist()).toBe(false);

    expect((await prepareTargets(approvalId, [first, second])).toSorted()).toEqual(
      [first.subscriptionId, second.subscriptionId].toSorted(),
    );
    expect(deliveriesExist()).toBe(true);
    await closeOpenClawStateDatabaseAsync();

    const expectedSubscriptionIds = [first, second]
      .toSorted(
        (a, b) => a.createdAtMs - b.createdAtMs || a.subscriptionId.localeCompare(b.subscriptionId),
      )
      .map((subscription) => subscription.subscriptionId);
    expect((await targets(approvalId)).map((subscription) => subscription.subscriptionId)).toEqual(
      expectedSubscriptionIds,
    );

    await deleteTargets(approvalId, second.subscriptionId);
    await closeOpenClawStateDatabaseAsync();
    expect(await targets(approvalId)).toEqual([first]);

    await resolveApproval(approvalId);
    expect(await listTerminalWebPushApprovalDeliveryIds({ stateDir: tmpDir })).toEqual({
      approvalIds: [approvalId],
      nextAfterApprovalId: null,
      throughApprovalId: approvalId,
    });

    await deleteTargets(approvalId, first.subscriptionId);
    expect(await targets(approvalId)).toEqual([]);
  });

  it("prepares remaining approval targets after subscriptions are removed or rebound", async () => {
    const approvalId = "exec:changed-push-targets";
    await insertPendingApproval(approvalId);
    for (const deviceId of ["removed", "rebound", "unchanged"]) {
      await registerTarget(deviceId, `profile-${deviceId}`);
    }
    const originalSubscriptions = await readBoundSubscriptions(tmpDir);
    const unchanged = originalSubscriptions.filter(
      (subscription) => subscription.deviceId === "unchanged",
    );
    expect(unchanged).toHaveLength(1);
    await expect(
      clearSubscription(pushUrl("removed"), deviceBinding("removed", "profile-removed")),
    ).resolves.toBe(true);
    await registerBound(pushUrl("rebound"), deviceBinding("new-device", "new-profile"));

    await expect(prepareTargets(approvalId, originalSubscriptions)).resolves.toEqual(
      unchanged.map((subscription) => subscription.subscriptionId),
    );
    expect(await targets(approvalId)).toEqual(unchanged);
  });

  it("cascades delivery targets when the browser subscription is removed", async () => {
    const approvalId = "exec:removed-push-target";
    await insertPendingApproval(approvalId);
    const subscription = await registerTarget("removed", "profile-removed");
    expect(await prepareTargets(approvalId, [subscription])).toEqual([subscription.subscriptionId]);

    await expect(clearSubscription(subscription.endpoint, subscription)).resolves.toBe(true);
    expect(await targets(approvalId)).toEqual([]);
  });

  it("rejects a terminal target after the endpoint is rebound to another owner", async () => {
    const approvalId = "exec:rebound-push-target";
    await insertPendingApproval(approvalId);
    const original = await registerTarget("original", "profile-original");
    expect(await prepareTargets(approvalId, [original])).toEqual([original.subscriptionId]);
    await resolveApproval(approvalId);
    await closeOpenClawStateDatabaseAsync();

    const rebound = await registerSubscription(original.endpoint, {
      keys: original.keys,
      binding: { deviceId: "device-rebound", userProfileId: "profile-rebound" },
    });
    expect(rebound.subscriptionId).toBe(original.subscriptionId);
    expect(
      (await listTerminalWebPushApprovalDeliveryIds({ stateDir: tmpDir })).approvalIds,
    ).toContain(approvalId);
    expect(await targets(approvalId)).toEqual([]);
    expect(
      (await listTerminalWebPushApprovalDeliveryIds({ stateDir: tmpDir })).approvalIds,
    ).not.toContain(approvalId);
  });
});

describe("sending", () => {
  it("configures VAPID once and broadcasts to registered subscriptions", async () => {
    for (const suffix of ["a", "b"]) {
      const endpoint = pushUrl(suffix);
      const binding = deviceBinding(suffix);
      await registerBound(endpoint, binding);
      expect(
        await setPreferences(
          endpoint,
          {
            enabled: true,
            label: "Browser",
            agentIds: Array.from({ length: 128 }, (_, i) => `agent-${i}`.padEnd(128, "x")),
          },
          binding,
        ),
      ).toBe(true);
    }
    const subscriptions = await listWebPushSubscriptions(tmpDir);
    const { db } = stateDatabase();
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(db),
      ["subscriptions"],
      (sql) =>
        /^select\b/i.test(sql) && sql.includes('"web_push_subscriptions"') ? "subscriptions" : null,
    );
    try {
      expect(await broadcastTitle("Broadcast")).toEqual(
        subscriptions.map(({ subscriptionId }) => ({ ok: true, subscriptionId, statusCode: 201 })),
      );
      expect(vi.mocked(webPush.setVapidDetails)).toHaveBeenCalledTimes(1);
      expect(sendNotification.mock.calls).toEqual(
        subscriptions.map(({ endpoint, keys: subscriptionKeys }) => [
          { endpoint, keys: subscriptionKeys },
          JSON.stringify({ title: "Broadcast" }),
          undefined,
        ]),
      );
      expect(reads.counts.subscriptions).toBe(0);
    } finally {
      reads.restore();
    }
  });

  it("sends a bounded high-urgency notification only to selected subscriptions", async () => {
    const selected = await registerSubscription("https://push.example.com/selected");
    await registerSubscription("https://push.example.com/not-selected");

    const send = await prepareWebPushNotificationSender(tmpDir);
    const payload = { title: "Approval", url: "/approve/1" };
    const deliveryOptions = { TTL: 60, urgency: "high" as const, timeout: 10_000 };
    await expect(send({ subscriptions: [selected], payload, deliveryOptions })).resolves.toEqual([
      { ok: true, subscriptionId: selected.subscriptionId, statusCode: 201 },
    ]);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: selected.endpoint, keys: selected.keys },
      JSON.stringify(payload),
      deliveryOptions,
    );
  });

  it.each([false, true])(
    "keeps the notice when its optional icon exceeds the push budget: %s",
    async (oversized) => {
      const selected = await registerSubscription("https://push.example.com/avatar");
      const send = await prepareWebPushNotificationSender(tmpDir);
      const payload = {
        title: "Agent finished",
        body: oversized ? "🌱".repeat(800) : "Your agent finished.",
        icon: `data:image/png;base64,${"A".repeat(1_000)}`,
        url: "/chat/research",
      };
      await send({ subscriptions: [selected], payload });
      const encoded = vi.mocked(webPush.sendNotification).mock.calls[0]?.[1] as string;
      const delivered = JSON.parse(encoded);
      expect(delivered).toMatchObject({
        title: payload.title,
        body: payload.body,
        url: payload.url,
      });
      expect(delivered.icon).toBe(oversized ? undefined : payload.icon);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(3_993);
    },
  );

  it.each([404, 410, 401, 403, 413, 429, 503, undefined])(
    "keeps successful sends alongside a failed delivery (status=%s)",
    async (statusCode) => {
      const failed = await registerSubscription("https://push.example.com/failed");
      const delivered = await registerSubscription("https://push.example.com/delivered");
      sendNotification.mockImplementation(async (subscription) => {
        if (subscription.endpoint === failed.endpoint) {
          throw Object.assign(new Error("delivery failed"), {
            statusCode,
            body: "synthetic push-service reason",
            code: "SYNTHETIC_FAILURE",
          });
        }
        return { statusCode: 201, body: "", headers: {} };
      });

      const failure = {
        subscriptionId: failed.subscriptionId,
        statusCode,
        error: "delivery failed",
      };
      const results = await broadcastTitle("Mixed broadcast");
      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          { ok: false, ...failure },
          { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
        ]),
      );
      expect(webPushWarn).toHaveBeenCalledWith("Web Push delivery failed", {
        ...failure,
        endpointHost: "push.example.com",
        errorName: "Error",
        errorCode: "SYNTHETIC_FAILURE",
        responseBody: "synthetic push-service reason",
        retry: false,
        subscriptionAction: statusCode === 404 || statusCode === 410 ? "prune" : "retain",
      });
      const expired = statusCode === 404 || statusCode === 410;
      const remaining = await listSubscriptions();
      expect(remaining).toEqual(
        expired ? [delivered] : expect.arrayContaining([failed, delivered]),
      );
      expect(remaining).toHaveLength(expired ? 1 : 2);
      sendNotification.mockClear();
      await broadcastTitle("Next notification");
      expect(sendNotification.mock.calls.map(([subscription]) => subscription.endpoint)).toEqual(
        remaining.map((subscription) => subscription.endpoint),
      );
    },
  );

  it("does not delete a subscription re-registered during an expired send", async ({ signal }) => {
    const endpoint = "https://push.example.com/reregistered";
    await registerSubscription(endpoint);
    await using broadcast = startExpiredWebPushBroadcast({ title: "Race" }, signal);
    await broadcast.started;
    const replacement = await registerSubscription(endpoint, {
      keys: { p256dh: "replacement-p256dh", auth: "replacement-auth" },
    });
    await broadcast.finish();

    expect(await listSubscriptions()).toEqual([replacement]);
  });

  it("refreshes bound-subscription presence after expired-delivery cleanup", async () => {
    await registerBound("https://push.example.com/expired-bound", deviceBinding("browser-device"));
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(true);
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));
    expect(await broadcastTitle("Expired")).toEqual([
      expect.objectContaining({ ok: false, statusCode: 410 }),
    ]);
    expect(await hasBoundWebPushSubscriptions(tmpDir)).toBe(false);
  });

  it("does not delete an expired subscription after a legacy claim appears", async ({ signal }) => {
    const endpoint = "https://push.example.com/pending-claim";
    const subscription = await registerSubscription(endpoint);
    await using broadcast = startExpiredWebPushBroadcast({ title: "Race" }, signal);
    await broadcast.started;
    await writeLegacy("web-push-subscriptions.json.doctor-importing");

    await expect(broadcast.finish()).resolves.toEqual([
      expect.objectContaining({ ok: false, statusCode: 410 }),
    ]);
    expect(await listSubscriptions()).toEqual([subscription]);
    expect(webPushWarn).toHaveBeenCalledWith(
      "Web Push expired subscription cleanup failed",
      expect.objectContaining({
        subscriptionId: subscription.subscriptionId,
        endpointHost: "push.example.com",
        error: expect.stringContaining("doctor --fix"),
        retry: false,
      }),
    );
  });

  it("keeps completed delivery results when expired-subscription cleanup fails", async ({
    signal,
  }) => {
    const endpoint = "https://push.example.com/expired";
    await registerSubscription(endpoint);
    await resolveVapidKeys(tmpDir);
    await using broadcast = startExpiredWebPushBroadcast({ title: "Expired" }, signal);
    await broadcast.started;
    await closeOpenClawStateDatabaseAsync();
    const databasePath = path.join(tmpDir, "state", "openclaw.sqlite");
    await fs.rename(databasePath, `${databasePath}.backup`);
    await fs.mkdir(databasePath);

    await expect(broadcast.finish()).resolves.toEqual([
      expect.objectContaining({ ok: false, statusCode: 410 }),
    ]);
  });
});

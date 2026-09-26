// Test-support for task Web Push delivery through gateway event subscriptions.
// Verifies that restart re-projection of an unchanged terminal task row does not
// resend offline Web Push, and that the spawner's notifyPolicy: "silent" suppresses push.
import { describe, expect, it, vi } from "vitest";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";

type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];
type Subscriptions = ReturnType<typeof startGatewayEventSubscriptions>;
type CapturedBroadcast = { event: string; payload: unknown; opts?: unknown };

const {
  listDevicePairingMock,
  listBoundWebPushSubscriptionsMock,
  hasBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSenderMock,
  preparedWebPushSendMock,
  resolveUserProfileIdMock,
  getUserPreferencesMock,
  resolveOperatorRolePolicyForProfileMock,
  canReceiveSessionEventMock,
} = vi.hoisted(() => ({
  listDevicePairingMock: vi.fn(),
  listBoundWebPushSubscriptionsMock: vi.fn(),
  hasBoundWebPushSubscriptionsMock: vi.fn(),
  prepareWebPushNotificationSenderMock: vi.fn(),
  preparedWebPushSendMock: vi.fn(),
  resolveUserProfileIdMock: vi.fn(),
  getUserPreferencesMock: vi.fn(),
  resolveOperatorRolePolicyForProfileMock: vi.fn(),
  canReceiveSessionEventMock: vi.fn(),
}));

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: async <T>(
    _stateDir: string | undefined,
    prepare: (
      paired: import("../infra/device-pairing.types.js").PairedDevice[],
    ) => { start: () => T } | undefined,
  ) => prepare(listDevicePairingMock().paired)?.start(),
}));

vi.mock("../infra/push-web.js", () => ({
  listBoundWebPushSubscriptions: listBoundWebPushSubscriptionsMock,
  withBoundWebPushSubscriptions: async <T>(
    stateDir: string | undefined,
    prepare: (
      subscriptions: BoundWebPushSubscription[],
      assertCurrent: () => void,
    ) => { start: () => T } | undefined | Promise<{ start: () => T } | undefined>,
  ) => (await prepare(await listBoundWebPushSubscriptionsMock(stateDir), () => {}))?.start(),
  hasBoundWebPushSubscriptions: hasBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSender: prepareWebPushNotificationSenderMock,
}));

vi.mock("../state/user-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profiles.js")>()),
  resolveUserProfileId: resolveUserProfileIdMock,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferences: getUserPreferencesMock,
}));

vi.mock("./operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-role-policy.js")>()),
  resolveOperatorRolePolicyForProfile: resolveOperatorRolePolicyForProfileMock,
}));

vi.mock("./session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing.js")>()),
  canReceiveSessionEvent: canReceiveSessionEventMock,
}));

const { createEventWebPushDelivery } = await import("./event-web-push.js");
const { configureTaskRegistryRuntime, getTaskRegistryObservers, onTaskRegistryChange } =
  await import("../tasks/task-registry.store.js");
const { emitTaskRegistryObserverEvent, ensureTaskRegistryReadyAsync } =
  await import("../tasks/task-registry-state.js");
const { failTaskRunByRunIdCore } = await import("../tasks/task-executor.js");
const { createInMemoryTaskRegistryStore } = await import("../test-utils/task-registry-store.js");

const RUN_ID = "run-156888";
const TASK_ID = "task-156888";

function boundSubscription(): BoundWebPushSubscription {
  return {
    subscriptionId: "subscription-browser",
    endpoint: "https://push.example.test/browser",
    keys: { p256dh: "p256dh-browser", auth: "auth-browser" },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId: "browser-device",
    userProfileId: null,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        humanMentioned: true,
        scheduledTaskFailed: true,
        backgroundTaskFailed: true,
      },
    },
  };
}

function pairedOperator(deviceId: string) {
  const scopes = ["operator.read"];
  return {
    deviceId,
    roles: ["operator"],
    role: "operator",
    scopes,
    approvedScopes: scopes,
    tokens: { operator: { token: `token-${deviceId}`, role: "operator", scopes } },
  };
}

function runningSubagentTask(notifyPolicy: TaskRecord["notifyPolicy"]): TaskRecord {
  return {
    taskId: TASK_ID,
    runtime: "subagent",
    taskKind: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    childSessionKey: "agent:main:child-156888",
    runId: RUN_ID,
    scopeKind: "session",
    task: "Retained subagent task (plugin:workboard)",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy,
    createdAt: 1,
    startedAt: 2,
  };
}

async function bootRegistryWithTask(task: TaskRecord) {
  const store = createInMemoryTaskRegistryStore({
    tasks: new Map([[task.taskId, task]]),
    deliveryStates: new Map(),
  });
  configureTaskRegistryRuntime({ store });
  const context = captureOpenClawStateWorkerContext();
  await ensureTaskRegistryReadyAsync(context);
  return { store };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function configureWebPushMocks(): void {
  listBoundWebPushSubscriptionsMock.mockResolvedValue([boundSubscription()]);
  hasBoundWebPushSubscriptionsMock.mockResolvedValue(true);
  listDevicePairingMock.mockReturnValue({
    pending: [],
    paired: [pairedOperator("browser-device")],
  });
  prepareWebPushNotificationSenderMock.mockResolvedValue(preparedWebPushSendMock);
  preparedWebPushSendMock.mockResolvedValue([]);
  resolveUserProfileIdMock.mockImplementation((profileId: string) => profileId);
  getUserPreferencesMock.mockReturnValue({});
  resolveOperatorRolePolicyForProfileMock.mockReturnValue(undefined);
  canReceiveSessionEventMock.mockReturnValue(true);
}

function createWebPushBroadcast(broadcasts: CapturedBroadcast[]): SubscriptionParams["broadcast"] {
  const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
  return (event, payload, opts) => {
    broadcasts.push({ event, payload, opts });
    delivery.handleEvent(event, payload, opts);
  };
}

async function disposeSubscriptions(subs: Subscriptions): Promise<void> {
  await subs.taskUnsub();
  await subs.agentUnsub();
  subs.heartbeatUnsub();
  subs.transcriptUnsub();
  subs.lifecycleUnsub();
}

export function registerTaskWebPushTests(
  start: (overrides: Partial<SubscriptionParams>) => Subscriptions,
  _mockLog: SubsystemLogger,
) {
  const waitForFast = (callback: () => unknown) => vi.waitFor(callback, { interval: 1 });

  describe("task failure Web Push", () => {
    it("does not re-push an already-failed retained task after a gateway restart", async () => {
      const task = runningSubagentTask("done_only");
      const { store } = await bootRegistryWithTask(task);
      configureWebPushMocks();

      // Process A: the task fails for real, once. A genuine transition pushes.
      const broadcastsA: CapturedBroadcast[] = [];
      const first = start({ broadcast: createWebPushBroadcast(broadcastsA) });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
      failTaskRunByRunIdCore({
        runId: RUN_ID,
        endedAt: 100,
        lastEventAt: 100,
        error: "task failed on 2026-09-22",
      });
      await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledTimes(1));
      await disposeSubscriptions(first);

      // Process B: the gateway restarts and the restore replay re-projects the
      // retained terminal row as `previous=failed next=failed`.
      configureTaskRegistryRuntime({ store });
      const rawEvents: string[] = [];
      const unsubscribe = onTaskRegistryChange((event) => {
        if (event?.kind === "upserted") {
          rawEvents.push(`upserted previous=${event.previous?.status} next=${event.task.status}`);
        } else if (event) {
          rawEvents.push(event.kind);
        }
      });
      preparedWebPushSendMock.mockClear();
      const broadcastsB: CapturedBroadcast[] = [];
      start({ broadcast: createWebPushBroadcast(broadcastsB) });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
      // A real restore clears in-memory publication de-dupe state.
      emitTaskRegistryObserverEvent(() => ({ kind: "restored" }));
      failTaskRunByRunIdCore({
        runId: RUN_ID,
        endedAt: 100,
        lastEventAt: 100,
        error: "task failed on 2026-09-22",
      });
      await flushAsyncWork();
      unsubscribe();

      expect(rawEvents).toContain(`upserted previous=failed next=failed`);
      // The Control UI still receives the ordinary upserted task broadcast...
      const upserted = broadcastsB.filter(
        (entry) =>
          entry.event === "task" && (entry.payload as { action?: string }).action === "upserted",
      );
      expect(upserted.length).toBeGreaterThan(0);
      // ...but no second offline Web Push is sent for the unchanged terminal row.
      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(0);
    });

    it("does not Web Push a failed task whose notifyPolicy is silent", async () => {
      const task = runningSubagentTask("silent");
      await bootRegistryWithTask(task);
      configureWebPushMocks();

      const broadcasts: CapturedBroadcast[] = [];
      start({ broadcast: createWebPushBroadcast(broadcasts) });
      await waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
      failTaskRunByRunIdCore({
        runId: RUN_ID,
        endedAt: 100,
        lastEventAt: 100,
        error: "task failed on 2026-09-22",
      });
      await flushAsyncWork();

      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(0);
    });
  });
}

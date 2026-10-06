import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlNextRecoverySleep } from "../../../test/helpers/infra/delivery-recovery.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { beginConversationDeliveryOperation } from "../../config/sessions/conversation-delivery-store.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { drainPendingDeliveries as drainPluginPendingDeliveries } from "../../plugin-sdk/delivery-queue-runtime.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  type DeliverFn,
  drainPendingDeliveriesCore,
  recoverPendingDeliveries,
  withActiveDeliveryClaim,
} from "./delivery-queue-recovery.js";
import { enqueueDelivery, failDelivery } from "./delivery-queue-storage.js";
import {
  loadPendingDeliveries,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const RECOVERY_REPLAY_SPACING_MS = 250;
const stubCfg: OpenClawConfig = {};
const NO_LISTENER_ERROR = "No active DirectChat listener";
const sleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());
const resolveOutboundChannelMessageAdapterMock = vi.hoisted(() => vi.fn());
const migrateLegacyPendingOutboundDeliveriesMock = vi.hoisted(() =>
  vi.fn(async () => ({ moved: 0, skipped: 0, remaining: 0 })),
);

vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveOutboundChannelMessageAdapterMock,
}));
vi.mock("./delivery-queue-migration.js", () => ({
  migrateLegacyPendingOutboundDeliveries: migrateLegacyPendingOutboundDeliveriesMock,
}));

describe("drainPendingDeliveriesCore for reconnect", () => {
  let tmpDir: string;
  const fixtures = installDeliveryQueueTmpDirHooks();
  let log = createRecoveryLog();
  const deliver = vi.fn<DeliverFn>();
  const selectEntry: Parameters<typeof drainPendingDeliveriesCore>[0]["selectEntry"] = (entry) => ({
    match: entry.channel === "directchat" && entry.accountId === "acct1",
    bypassBackoff: entry.lastError?.includes(NO_LISTENER_ERROR),
  });
  function drain(overrides: Partial<Parameters<typeof drainPendingDeliveriesCore>[0]> = {}) {
    return drainPendingDeliveriesCore({
      drainKey: "directchat:acct1",
      logLabel: "DirectChat reconnect drain",
      cfg: stubCfg,
      log,
      stateDir: tmpDir,
      deliver,
      selectEntry,
      ...overrides,
    });
  }
  function recover(recoveryLog = createRecoveryLog()) {
    return recoverPendingDeliveries({ cfg: stubCfg, log: recoveryLog, stateDir: tmpDir, deliver });
  }
  function enqueue(overrides: Partial<Parameters<typeof enqueueDelivery>[0]> = {}) {
    return enqueueDelivery(
      {
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "hi" }],
        accountId: "acct1",
        ...overrides,
      },
      tmpDir,
    );
  }
  async function enqueueFailed() {
    const id = await enqueue();
    await failDelivery(id, NO_LISTENER_ERROR, tmpDir);
    return id;
  }

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    log = createRecoveryLog();
    deliver.mockReset().mockResolvedValue(undefined);
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
    resolveOutboundChannelMessageAdapterMock.mockReset();
    migrateLegacyPendingOutboundDeliveriesMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one-time migration out of repeated canonical drains", async () => {
    await drain();
    await drain();
    await drain();

    expect(migrateLegacyPendingOutboundDeliveriesMock).not.toHaveBeenCalled();
  });

  it("leaves Gateway conversation records for the authorized recovery owner", async () => {
    const operationId = "conversation-reconnect";
    const storePath = path.join(tmpDir, "agent-sessions.json");
    const scope = { agentId: "main", storePath };
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    });
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
      {
        sessionId: "reef-session",
        updatedAt: 100,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
          origin: {
            provider: "reef",
            accountId: "default",
            nativeDirectUserId: "peer-agent",
          },
        }),
      },
    );
    await beginConversationDeliveryOperation(scope, {
      operationId,
      operationKind: "send",
      conversationRef,
      message: "deliver only through the authorized recovery owner",
      preparedMessageId: "reef-prepared",
    });
    const id = await enqueueDelivery(
      {
        channel: "reef",
        to: "reef:peer-agent",
        accountId: "default",
        payloads: [{ text: "deliver only through the authorized recovery owner" }],
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId,
          storePath,
          routeFingerprint: "route-reconnect",
        },
      },
      tmpDir,
    );
    await failDelivery(id, NO_LISTENER_ERROR, tmpDir);
    deliver.mockImplementation(async () => {
      throw new PlatformMessageNotDispatchedError(
        "Conversation delivery is missing its current route authorization",
        { cause: undefined, retryable: false },
      );
    });

    await drainPluginPendingDeliveries({
      drainKey: "reef:default",
      logLabel: "Reef reconnect drain",
      cfg: stubCfg,
      log: createRecoveryLog(),
      stateDir: tmpDir,
      deliver,
      selectEntry: (entry) => ({
        match: entry.channel === "reef" && entry.accountId === "default",
        bypassBackoff: true,
      }),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect((await loadPendingDeliveries(tmpDir)).map((entry) => entry.id)).toContain(id);
  });

  it("retries deferred rows for every channel through the gateway-wide drain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const channels = ["discord", "slack", "signal"] as const;
    for (const channel of channels) {
      const id = await enqueueDelivery(
        {
          channel,
          to: `${channel}:recipient`,
          payloads: [{ text: `retry ${channel}` }],
        },
        tmpDir,
      );
      setQueuedEntryState(tmpDir, id, {
        retryCount: 1,
        lastAttemptAt: Date.now(),
        lastError: "temporary connection failure",
      });
    }
    deliver.mockImplementation(async (entry) => [
      { channel: entry.channel, messageId: `${entry.channel}-delivered` },
    ]);
    const drainAll = () =>
      drain({ drainKey: "gateway:outbound", selectEntry: () => ({ match: true }) });

    await expect(recover()).resolves.toMatchObject({
      recovered: 0,
      deferredBackoff: channels.length,
    });

    await drainAll();
    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(channels.length);

    vi.setSystemTime(Date.now() + 5_000);
    await drainAll();

    expect(deliver.mock.calls.map(([entry]) => entry.channel).toSorted()).toEqual(
      channels.toSorted(),
    );
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);

    await drainAll();
    expect(deliver).toHaveBeenCalledTimes(channels.length);
  });

  it("bounds stop admission independently of queued backlog size", async () => {
    for (const index of Array.from({ length: 64 }, (_, position) => position)) {
      const id = await enqueueDelivery(
        {
          channel: "directchat",
          to: `+1${String(index).padStart(3, "0")}`,
          payloads: [{ text: `queued ${index}` }],
        },
        tmpDir,
      );
      setQueuedEntryState(tmpDir, id, { retryCount: 0, enqueuedAt: index + 1 });
    }
    const pendingBefore = await loadPendingDeliveries(tmpDir);
    const { promise: firstStarted, resolve: signalFirstStarted } = createDeferred();
    const { promise: firstBlocked, resolve: releaseFirst } = createDeferred();
    deliver.mockImplementation(async () => {
      if (deliver.mock.calls.length === 1) {
        signalFirstStarted();
        await firstBlocked;
      }
    });
    let shouldContinue = true;

    const draining = drain({
      drainKey: "gateway:outbound",
      selectEntry: () => ({ match: true }),
      shouldContinue: () => shouldContinue,
    });
    try {
      await Promise.race([firstStarted, draining]);
      expect(deliver).toHaveBeenCalledOnce();
    } finally {
      shouldContinue = false;
      releaseFirst();
      await draining;
    }

    expect(deliver).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toEqual(pendingBefore.slice(1));
  });

  it("retries immediately without resetting retry history", async () => {
    deliver.mockRejectedValue(new Error("transient failure"));

    const id = await enqueueFailed();
    const before = readQueuedEntry(tmpDir, id);

    await drain();

    expect(deliver).toHaveBeenCalledTimes(1);

    const after = readQueuedEntry(tmpDir, id);
    expect(after.retryCount).toBe(Number(before.retryCount) + 1);
    expect(after.lastAttemptAt).toBeTypeOf("number");
    expect(after.lastAttemptAt).toBeGreaterThanOrEqual(Number(before.lastAttemptAt ?? 0));
    expect(after.lastError).toBe("transient failure");
  });

  it("second concurrent call is skipped (concurrency guard)", async () => {
    const { promise: deliverPromise, resolve: resolveDeliver } = createDeferred();
    deliver.mockImplementation(async () => {
      await deliverPromise;
    });

    const id = await enqueue();
    setQueuedEntryState(tmpDir, id, { retryCount: 0, lastError: NO_LISTENER_ERROR });

    const first = drain();
    try {
      await drain();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already in progress"));
    } finally {
      resolveDeliver();
      await first;
    }
  });

  it("shares replay pacing between reconnect and startup drains", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      const startupLog = createRecoveryLog();
      const { promise: firstStartedPromise, resolve: firstStarted } = createDeferred();
      const { promise: firstBlocked, resolve: releaseFirst } = createDeferred();
      const deliveryTimes: number[] = [];
      deliver.mockImplementation(async () => {
        deliveryTimes.push(Date.now());
        if (deliveryTimes.length === 1) {
          firstStarted();
          await firstBlocked;
        }
      });

      for (const to of ["+1000", "+2000"]) {
        await enqueue({ to });
      }

      const reconnectDrain = drain();
      await firstStartedPromise;
      const startupRecovery = recover(startupLog);
      releaseFirst();

      await expect(controlledSleep.started).resolves.toBe(RECOVERY_REPLAY_SPACING_MS);
      expect(deliver).toHaveBeenCalledTimes(1);
      controlledSleep.release();
      await Promise.all([reconnectDrain, startupRecovery]);

      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliveryTimes).toEqual([
        startedAt.getTime(),
        startedAt.getTime() + RECOVERY_REPLAY_SPACING_MS,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-deliver a stale startup snapshot after reconnect already acked it", async () => {
    const startupLog = createRecoveryLog();
    const { promise: blockerStarted, resolve: signalBlockerStarted } = createDeferred();
    const { promise: blocker, resolve: releaseBlocker } = createDeferred();
    const deliveredTargets: string[] = [];
    deliver.mockImplementation(async ({ to }) => {
      deliveredTargets.push(to);
      if (to === "+1000") {
        signalBlockerStarted();
        await blocker;
      }
    });

    const blockerId = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1000", payloads: [{ text: "blocker" }] },
      tmpDir,
    );
    const directChatId = await enqueue();
    setQueuedEntryState(tmpDir, blockerId, { retryCount: 0, enqueuedAt: 1 });
    setQueuedEntryState(tmpDir, directChatId, { retryCount: 0, enqueuedAt: 2 });

    const startupRecovery = recover(startupLog);

    try {
      await Promise.race([blockerStarted, startupRecovery]);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "demo-channel-a", to: "+1000" }),
      );

      await drain();
    } finally {
      releaseBlocker();
      await startupRecovery;
    }

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliveredTargets.filter((target) => target === "+1555")).toHaveLength(1);
    expect(startupLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Recovery skipped for delivery"),
    );
  });
  it("recomputes backoff bypass after rereading the claimed entry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await enqueue();
    setQueuedEntryState(tmpDir, id, {
      retryCount: 1,
      lastAttemptAt: Date.now(),
      lastError: NO_LISTENER_ERROR,
    });
    let mutated = false;

    await drain({
      selectEntry: (entry) => {
        if (entry.id === id && !mutated) {
          mutated = true;
          setQueuedEntryState(tmpDir, id, {
            retryCount: entry.retryCount,
            lastAttemptAt: entry.lastAttemptAt,
            lastError: "network down",
          });
        }
        return selectEntry(entry, Date.now());
      },
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("not ready for retry yet"));
  });

  it("skips entries that an in-flight live delivery has actively claimed", async () => {
    // #70386: reconnect must share the live sender's active claim.

    const id = await enqueue();

    const claimResult = await withActiveDeliveryClaim(id, async () => {
      await drain();
      await drain();
      expect(deliver).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
    });
    expect(claimResult.status).toBe("claimed");

    await drain();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

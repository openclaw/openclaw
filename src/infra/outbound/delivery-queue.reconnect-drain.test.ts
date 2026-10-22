import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlNextRecoverySleep } from "../../../test/helpers/infra/delivery-recovery.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { drainPendingDeliveries as drainPluginPendingDeliveries } from "../../plugin-sdk/delivery-queue-runtime.js";
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
  prepareConversationDelivery,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const RECOVERY_REPLAY_SPACING_MS = 250;
const stubCfg = {};
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
  const pending = () => loadPendingDeliveries(tmpDir);
  function expectInfo(logger: typeof log, message: string) {
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(message));
  }
  const selectEntry: Parameters<typeof drainPendingDeliveriesCore>[0]["selectEntry"] = (entry) => ({
    match: entry.channel === "directchat" && entry.accountId === "acct1",
    bypassBackoff: entry.lastError?.includes(NO_LISTENER_ERROR),
  });
  function drain(overrides: Partial<Parameters<typeof drainPendingDeliveriesCore>[0]> = {}) {
    return drainPendingDeliveriesCore({
      ...options(),
      drainKey: "directchat:acct1",
      logLabel: "DirectChat reconnect drain",
      selectEntry,
      ...overrides,
    });
  }
  const options = () => ({ cfg: stubCfg, log, stateDir: tmpDir, deliver });
  function recover(recoveryLog = createRecoveryLog()) {
    return recoverPendingDeliveries({ ...options(), log: recoveryLog });
  }
  function drainAll(overrides: Partial<Parameters<typeof drainPendingDeliveriesCore>[0]> = {}) {
    return drain({
      drainKey: "gateway:outbound",
      selectEntry: () => ({ match: true }),
      ...overrides,
    });
  }
  async function enqueue(
    overrides: Partial<Parameters<typeof enqueueDelivery>[0]> = {},
    state?: Parameters<typeof setQueuedEntryState>[2],
  ) {
    const id = await enqueueDelivery(
      {
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "hi" }],
        accountId: "acct1",
        ...overrides,
      },
      tmpDir,
    );
    if (state) {
      setQueuedEntryState(tmpDir, id, state);
    }
    return id;
  }
  function blockDelivery(
    matches: (entry: Parameters<DeliverFn>[0]) => boolean = () => true,
    observe: (entry: Parameters<DeliverFn>[0]) => void = () => {},
  ) {
    const entered = createDeferred();
    const blocked = createDeferred();
    deliver.mockImplementation(async (entry) => {
      observe(entry);
      if (matches(entry)) {
        entered.resolve();
        await blocked.promise;
      }
    });
    return { entered: entered.promise, release: blocked.resolve };
  }

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    log = createRecoveryLog();
    deliver.mockReset().mockResolvedValue(undefined);
    sleepMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("leaves Gateway conversation records for the authorized recovery owner", async () => {
    const operationId = "conversation-reconnect";
    const storePath = path.join(tmpDir, "agent-sessions.json");
    const scope = { agentId: "main", storePath };
    const delivery = await prepareConversationDelivery(
      scope,
      operationId,
      "deliver only through the authorized recovery owner",
      "route-reconnect",
    );
    const id = await enqueue({ ...delivery, accountId: "default" });
    await failDelivery(id, NO_LISTENER_ERROR, tmpDir);
    await drainPluginPendingDeliveries({
      ...options(),
      drainKey: "reef:default",
      logLabel: "Reef reconnect drain",
      log: createRecoveryLog(),
      selectEntry: (entry) => ({
        match: entry.channel === "reef" && entry.accountId === "default",
        bypassBackoff: true,
      }),
    });
    expect(deliver).not.toHaveBeenCalled();
    expect((await pending()).map((entry) => entry.id)).toContain(id);
  });

  it("retries deferred rows for every channel through the gateway-wide drain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const channels = ["discord", "slack", "signal"] as const;
    for (const channel of channels) {
      await enqueue(
        {
          channel,
          to: `${channel}:recipient`,
          accountId: undefined,
        },
        { retryCount: 1, lastAttemptAt: Date.now(), lastError: "temporary connection failure" },
      );
    }
    deliver.mockImplementation(async (entry) => [
      { channel: entry.channel, messageId: `${entry.channel}-delivered` },
    ]);
    await expect(recover()).resolves.toMatchObject({
      recovered: 0,
      deferredBackoff: channels.length,
    });
    await drainAll();
    expect(deliver).not.toHaveBeenCalled();
    expect(await pending()).toHaveLength(channels.length);
    vi.setSystemTime(Date.now() + 5_000);
    await drainAll();
    expect(deliver.mock.calls.map(([entry]) => entry.channel).toSorted()).toEqual(
      channels.toSorted(),
    );
    expect(await pending()).toEqual([]);
    await drainAll();
    expect(deliver).toHaveBeenCalledTimes(channels.length);
  });

  it("bounds stop admission independently of queued backlog size", async () => {
    for (let index = 0; index < 64; index++) {
      await enqueue({ accountId: undefined }, { retryCount: 0, enqueuedAt: index + 1 });
    }
    const pendingBefore = await pending();
    const first = blockDelivery(() => deliver.mock.calls.length === 1);
    let shouldContinue = true;
    const draining = drainAll({ shouldContinue: () => shouldContinue });
    try {
      await Promise.race([first.entered, draining]);
      expect(deliver).toHaveBeenCalledOnce();
    } finally {
      shouldContinue = false;
      first.release();
      await draining;
    }
    expect(deliver).toHaveBeenCalledOnce();
    expect(await pending()).toEqual(pendingBefore.slice(1));
  });

  it("retries immediately without resetting retry history", async () => {
    deliver.mockRejectedValue(new Error("transient failure"));
    const id = await enqueue();
    await failDelivery(id, NO_LISTENER_ERROR, tmpDir);
    const before = readQueuedEntry(tmpDir, id);
    await drain();
    expect(deliver).toHaveBeenCalledTimes(1);
    const after = readQueuedEntry(tmpDir, id);
    expect(after).toMatchObject({
      retryCount: Number(before.retryCount) + 1,
      lastError: "transient failure",
    });
    expect(after.lastAttemptAt).toBeTypeOf("number");
    expect(after.lastAttemptAt).toBeGreaterThanOrEqual(Number(before.lastAttemptAt ?? 0));
  });

  it("second concurrent call is skipped (concurrency guard)", async () => {
    const blocked = blockDelivery();
    await enqueue({}, { retryCount: 0, lastError: NO_LISTENER_ERROR });
    const first = drain();
    try {
      await drain();
      expectInfo(log, "already in progress");
    } finally {
      blocked.release();
      await first;
    }
  });

  it("shares replay pacing between reconnect and startup drains", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    const controlledSleep = controlNextRecoverySleep(sleepMock);
    const startupLog = createRecoveryLog();
    const deliveryTimes: number[] = [];
    const first = blockDelivery(
      () => deliveryTimes.length === 1,
      () => deliveryTimes.push(Date.now()),
    );
    for (const to of ["+1000", "+2000"]) {
      await enqueue({ to });
    }
    const reconnectDrain = drain();
    await first.entered;
    const startupRecovery = recover(startupLog);
    first.release();
    await expect(controlledSleep.started).resolves.toBe(RECOVERY_REPLAY_SPACING_MS);
    expect(deliver).toHaveBeenCalledTimes(1);
    controlledSleep.release();
    await Promise.all([reconnectDrain, startupRecovery]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliveryTimes).toEqual([startedAt, startedAt + RECOVERY_REPLAY_SPACING_MS]);
  });

  it("does not re-deliver a stale startup snapshot after reconnect already acked it", async () => {
    const startupLog = createRecoveryLog();
    const blocker = blockDelivery(({ to }) => to === "+1000");
    await enqueue(
      {
        channel: "demo-channel-a",
        to: "+1000",
        accountId: undefined,
      },
      { retryCount: 0, enqueuedAt: 1 },
    );
    await enqueue({}, { retryCount: 0, enqueuedAt: 2 });
    const startupRecovery = recover(startupLog);
    try {
      await Promise.race([blocker.entered, startupRecovery]);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "demo-channel-a", to: "+1000" }),
      );
      await drain();
    } finally {
      blocker.release();
      await startupRecovery;
    }
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.filter(([entry]) => entry.to === "+1555")).toHaveLength(1);
    expectInfo(startupLog, "Recovery skipped for delivery");
  });
  it("recomputes backoff bypass after rereading the claimed entry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await enqueue(
      {},
      {
        retryCount: 1,
        lastAttemptAt: Date.now(),
        lastError: NO_LISTENER_ERROR,
      },
    );
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
    expectInfo(log, "not ready for retry yet");
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

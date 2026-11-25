import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlNextRecoverySleep } from "../../../test/helpers/infra/delivery-recovery.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  drainPendingDeliveriesCore,
  recoverPendingDeliveries,
  type DeliverFn,
} from "./delivery-queue-recovery.js";
import { enqueueDelivery, loadUnfinishedDeliveries } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

// mock-isolation: Exercise real queue custody with a fixed external send callback, not plugin I/O.
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: async () => undefined,
}));
const sleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());
// mock-isolation: Pacing has separate clock coverage; this worker-backed test has no timer waits.
vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));

describe("outbound recovery account isolation", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  beforeEach(() => {
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });
  afterEach(resetPluginRuntimeStateForTest);

  it("counts replay pacing against the recovery budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      await enqueueDelivery(
        {
          channel: "demo-channel-a",
          to: "+1",
          payloads: [{ text: "a" }],
          preparedMessageId: "prepared-message-a",
        },
        tmpDir(),
      );
      await enqueueDelivery(
        {
          channel: "demo-channel-b",
          to: "2",
          payloads: [{ text: "b" }],
          queuePolicy: "required",
          requireUnknownSendReconciliation: true,
        },
        tmpDir(),
      );
      await enqueueDelivery(
        { channel: "demo-channel-c", to: "#ch", payloads: [{ text: "c" }] },
        tmpDir(),
      );
      const firstSend = createDeferredCore();
      const deliver = vi.fn<DeliverFn>().mockImplementation(async () => {
        firstSend.resolve();
        return [];
      });
      const recovery = recoverPendingDeliveries({
        cfg: {},
        stateDir: tmpDir(),
        log: createRecoveryLog(),
        deliver,
        maxRecoveryMs: 1,
      });
      let pacingStarted = false;
      try {
        const wait = await awaitGateBeforeSettlement(
          controlledSleep.started,
          recovery,
          "recovery did not reach the replay pacer",
        );
        pacingStarted = true;
        expect(wait).toBe(1);
        // Another domain may reach the pacer while the first prepares its send.
        await awaitGateBeforeSettlement(firstSend.promise, recovery, "first replay did not send");
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        if (pacingStarted) {
          controlledSleep.release();
        }
        await recovery;
      }
      expect(await recovery).toMatchObject({ recovered: 1, deferredBackoff: 0 });
      expect(deliver).toHaveBeenCalledOnce();
      expect(await loadUnfinishedDeliveries(tmpDir())).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares the configured default account lane across startup and reconnect drains", async ({
    signal,
  }) => {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "recovery-proof",
        config: { listAccountIds: () => ["a", "b"], defaultAccountId: () => "a" },
      }),
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));
    const enqueue = (text: string, accountId?: string) =>
      enqueueDelivery(
        {
          channel: plugin.id,
          to: "recipient",
          payloads: [{ text }],
          ...(accountId ? { accountId } : {}),
        },
        tmpDir(),
      );
    const firstId = await enqueue("first");
    const firstStarted = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const sent: string[] = [];
    const deliver: DeliverFn = async (params) => {
      const text = params.payloads[0]?.text ?? "";
      if (text === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      sent.push(text);
      return [{ channel: plugin.id, messageId: `message-${text}` }];
    };
    const options = { cfg: {}, stateDir: tmpDir(), log: createRecoveryLog(), deliver };
    const startup = recoverPendingDeliveries(options);
    try {
      await withinTest(
        awaitGateBeforeSettlement(firstStarted.promise, startup, "first send did not start"),
        signal,
      );
      const nextId = await enqueue("next", "a");
      await enqueue("independent", "b");
      await withinTest(
        drainPendingDeliveriesCore({
          ...options,
          drainKey: "plugin:reconnect",
          logLabel: "reconnect",
          selectEntry: () => ({ match: true }),
        }),
        signal,
      );
      expect([...sent]).toEqual(["independent"]);
      const pending = await loadUnfinishedDeliveries(tmpDir());
      expect(pending.map((entry) => entry.id)).toEqual([firstId, nextId]);
      expect(pending.find((entry) => entry.id === nextId)?.retryCount).toBe(0);
      releaseFirst.resolve();
      await startup;
      await recoverPendingDeliveries(options);
      expect(sent).toEqual(["independent", "first", "next"]);
      expect(await loadUnfinishedDeliveries(tmpDir())).toEqual([]);
    } finally {
      releaseFirst.resolve();
      await startup;
    }
  });
});

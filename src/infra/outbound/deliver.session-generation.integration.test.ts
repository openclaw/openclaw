import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce, loadPendingDelivery } from "./delivery-queue-storage.js";
import { createRecoveryLog } from "./delivery-queue.test-helpers.js";

let deliver: typeof import("./deliver.js").deliverOutboundPayloadsInternal;
beforeAll(async () => {
  ({ deliverOutboundPayloadsInternal: deliver } = await import("./deliver.js"));
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function fixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const sessionKey = "agent:main:result-generation";
  const entry = { sessionId: "result-generation", lifecycleRevision: "original", updatedAt: 1 };
  writeSessionEntry(database, sessionKey, entry);
  const generation = {
    agentId: "main",
    storePath: database.path,
    sessionKey,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
  };
  const update = (revision: string) =>
    replaceSessionEntrySync(
      { agentId: "main", storePath: database.path, sessionKey },
      { ...entry, lifecycleRevision: revision, updatedAt: 2, label: "unrelated later turn" },
    );
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
      },
    ]),
  );
  return { generation, update };
}

describe("generation-bound result delivery", () => {
  it.each(["original", "reset"])(
    "rechecks %s generation after awaited dispatch preparation",
    async (revision) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { generation, update } = fixture();
        const entered = createDeferred();
        const released = createDeferred();
        const send = vi.fn(async () => ({ messageId: "result" }));
        const operation = deliver({
          cfg: {},
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "accepted result" }],
          queuePolicy: "required",
          deliveryIntentId: "sessions-send:held-result",
          reusePendingDeliveryIntent: true,
          sessionGeneration: generation,
          deps: { matrix: send },
          onPlatformSendDispatch: async () => {
            entered.resolve();
            await released.promise;
          },
        });
        const outcome = operation.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await Promise.race([
            entered.promise,
            operation.then(() => {
              throw new Error("Delivery settled before the dispatch barrier");
            }),
          ]);
          update(revision);
        } finally {
          released.resolve();
        }
        const result = await outcome;
        if (revision === "original") {
          expect(result).toMatchObject({ value: [{ messageId: "result" }] });
          expect(send).toHaveBeenCalledOnce();
        } else {
          expect(result).toHaveProperty("error");
          expect(send).not.toHaveBeenCalled();
          expect(
            getDeliveryQueueEntryStatus(
              SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME,
              "sessions-send:held-result",
            ),
          ).toBe("failed");
        }
        const ordinary = await deliver({
          cfg: {},
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "ordinary" }],
          deps: { matrix: send },
        });
        expect(ordinary).toMatchObject([{ messageId: "result" }]);
      });
    },
  );

  it("replays every same-generation result and terminalizes only revoked unsent results", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { generation, update } = fixture();
      const send = vi.fn(async (_to: string, text: string) => ({ messageId: text }));
      const enqueue = (id: string) =>
        enqueueDeliveryOnce(
          {
            channel: "matrix",
            to: "!room:example",
            payloads: [{ text: id }],
            sessionGeneration: generation,
            queuePolicy: "required",
            requiresProducerClaim: true,
          },
          id,
        );
      await enqueue("sessions-send:first");
      await enqueue("sessions-send:second");
      update("original");
      const replay = () =>
        recoverPendingDeliveries({
          cfg: {},
          log: createRecoveryLog(),
          deliver: (params) => deliver({ ...params, deps: { matrix: send } }),
        });
      await replay();
      expect(send.mock.calls.map((call) => call[1])).toEqual([
        "sessions-send:first",
        "sessions-send:second",
      ]);
      expect(await loadPendingDelivery("sessions-send:first")).toBeNull();
      expect(await loadPendingDelivery("sessions-send:second")).toBeNull();
      await enqueue("sessions-send:revoked");
      update("reset");
      await replay();
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        getDeliveryQueueEntryStatus(
          SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME,
          "sessions-send:revoked",
        ),
      ).toBe("failed");
    });
  });
});

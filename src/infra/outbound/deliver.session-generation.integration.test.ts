import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
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

  it("retains a completed result through temporary lifecycle unavailability", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const { generation, update } = fixture();
      const entered = createDeferred();
      const released = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: generation.storePath,
        identities: [generation.sessionKey, generation.sessionId],
        prepare: async () => {
          entered.resolve();
          await released.promise;
        },
        run: () => Promise.resolve(update("original")),
      });
      const send = vi.fn(async (_to: string, text: string) => ({ messageId: text }));
      const deliveryIntentId = "sessions-send:transient-result";
      try {
        await Promise.race([
          entered.promise,
          mutation.then(() => {
            throw new Error("Lifecycle mutation settled before its preparation barrier");
          }),
        ]);
        await expect(
          deliver({
            cfg: {},
            channel: "matrix",
            to: "!original:example",
            accountId: "original",
            payloads: [{ text: "completed result" }],
            queuePolicy: "required",
            deliveryIntentId,
            reusePendingDeliveryIntent: true,
            sessionGeneration: generation,
            deps: { matrix: send },
          }),
        ).rejects.toThrow("Session delivery generation is unavailable");
        expect(send).not.toHaveBeenCalled();
        expect(await loadPendingDelivery(deliveryIntentId)).toMatchObject({
          id: deliveryIntentId,
          to: "!original:example",
          accountId: "original",
          sessionGeneration: generation,
          preparedBatch: {
            sourcePayloadCount: 1,
            entries: [{ status: "accepted", payload: { text: "completed result" } }],
          },
        });
        await expect(
          deliver({
            cfg: {},
            channel: "matrix",
            to: "!ordinary:example",
            payloads: [{ text: "ordinary while held" }],
            deps: { matrix: send },
          }),
        ).resolves.toMatchObject([{ messageId: "ordinary while held" }]);
      } finally {
        released.resolve();
        await mutation;
      }
      const recover = () =>
        drainMatrixReconnect({
          stateDir,
          deliver: (params) => deliver({ ...params, deps: { matrix: send } }),
        });
      await recover();
      expect(send.mock.calls.map(([to, text]) => [to, text])).toEqual([
        ["!ordinary:example", "ordinary while held"],
        ["!original:example", "completed result"],
      ]);
      expect(send).toHaveBeenNthCalledWith(
        2,
        "!original:example",
        "completed result",
        expect.objectContaining({ accountId: "original" }),
      );
      expect(await loadPendingDelivery(deliveryIntentId)).toBeNull();
      await recover();
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

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

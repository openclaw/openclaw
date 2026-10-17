import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import { installQueueTestPlugin } from "./deliver.custody.test-support.js";
import { drainMatrixReconnect } from "./deliver.queue-integration.test-support.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce, loadPendingDelivery } from "./delivery-queue-storage.js";
import { createRecoveryLog } from "./delivery-queue.test-helpers.js";

let deliver: typeof import("./deliver.js").deliverOutboundPayloadsInternal;
type DeliveryOptions = Partial<Parameters<typeof deliver>[0]>;
const queueStatus = (id: string) =>
  getDeliveryQueueEntryStatus("outbound-session-generation-v1", id);
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
  installQueueTestPlugin();
  const send = vi.fn(async (_to: string, text: string) => ({ messageId: text }));
  const dispatch = (text: string, options: DeliveryOptions = {}) =>
    deliver({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text }],
      deps: { matrix: send },
      ...options,
    });
  const queued: DeliveryOptions = {
    queuePolicy: "required",
    reusePendingDeliveryIntent: true,
    sessionGeneration: generation,
  };
  return { generation, update, send, dispatch, queued };
}

function barrier() {
  const entered = createDeferred();
  const released = createDeferred();
  return {
    hold: async () => {
      entered.resolve();
      await released.promise;
    },
    release: () => released.resolve(),
    wait: (operation: Promise<unknown>) =>
      Promise.race([
        entered.promise,
        operation.then(() => {
          throw new Error("Operation settled before the barrier");
        }),
      ]),
  };
}

it.each(["original", "reset"])(
  "rechecks %s generation after awaited dispatch preparation",
  async (revision) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { update, send, dispatch, queued } = fixture();
      const gate = barrier();
      send.mockResolvedValue({ messageId: "result" });
      const operation = dispatch("accepted result", {
        ...queued,
        deliveryIntentId: "sessions-send:held-result",
        onPlatformSendDispatch: gate.hold,
      });
      const outcome = operation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await gate.wait(operation);
        update(revision);
      } finally {
        gate.release();
      }
      const result = await outcome;
      if (revision === "original") {
        expect(result).toMatchObject({ value: [{ messageId: "result" }] });
        expect(send).toHaveBeenCalledOnce();
      } else {
        expect(result).toHaveProperty("error");
        expect(send).not.toHaveBeenCalled();
        expect(queueStatus("sessions-send:held-result")).toBe("failed");
      }
      expect(await dispatch("ordinary")).toMatchObject([{ messageId: "result" }]);
    });
  },
);

it("retains a completed result through temporary lifecycle unavailability", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const { generation, update, send, dispatch, queued } = fixture();
    const gate = barrier();
    const mutation = runExclusiveSessionLifecycleMutation("reset", {
      scope: generation.storePath,
      identities: [generation.sessionKey, generation.sessionId],
      prepare: gate.hold,
      run: () => Promise.resolve(update("original")),
    });
    const deliveryIntentId = "sessions-send:transient-result";
    try {
      await gate.wait(mutation);
      await expect(
        dispatch("completed result", {
          ...queued,
          deliveryIntentId,
          to: "!original:example",
          accountId: "original",
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
        dispatch("ordinary while held", { to: "!ordinary:example" }),
      ).resolves.toMatchObject([{ messageId: "ordinary while held" }]);
    } finally {
      gate.release();
      await mutation;
    }
    const recover = () =>
      drainMatrixReconnect({
        stateDir,
        deliver: (params) => deliver({ ...params, deps: { matrix: send } }),
      });
    await recover();
    expect(send.mock.calls).toEqual([
      ["!ordinary:example", "ordinary while held", expect.anything()],
      ["!original:example", "completed result", expect.objectContaining({ accountId: "original" })],
    ]);
    expect(await loadPendingDelivery(deliveryIntentId)).toBeNull();
    await recover();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

it("replays every same-generation result and terminalizes only revoked unsent results", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { generation, update, send } = fixture();
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
    expect(queueStatus("sessions-send:revoked")).toBe("failed");
  });
});

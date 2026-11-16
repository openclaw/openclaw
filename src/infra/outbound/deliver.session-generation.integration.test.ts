import { expect, it, vi } from "vitest";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createDeliveryBarrier,
  installQueueTestPlugin,
  useOutboundRuntime,
} from "./deliver.custody.test-support.js";
import { drainMatrixReconnect } from "./deliver.queue-integration.test-support.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce, loadPendingDelivery } from "./delivery-queue-storage.js";
import { createRecoveryLog } from "./delivery-queue.test-helpers.js";

const { internal: deliver } = useOutboundRuntime();
type DeliveryOptions = Partial<Parameters<typeof deliver>[0]>;

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
  const update = (sessionId: string) =>
    replaceSessionEntrySync(
      { agentId: "main", storePath: database.path, sessionKey },
      { ...entry, sessionId, updatedAt: 2, label: "unrelated later turn" },
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

it.each(["result-generation", "rewound-generation"])(
  "rechecks %s transcript after awaited dispatch preparation",
  async (sessionId) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { update, send, dispatch, queued } = fixture();
      const gate = createDeliveryBarrier();
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
        update(sessionId);
      } finally {
        gate.release();
      }
      const result = await outcome;
      expect(result).toMatchObject({ value: [{ messageId: "result" }] });
      expect(send).toHaveBeenCalledOnce();
      expect(await dispatch("ordinary")).toMatchObject([{ messageId: "result" }]);
    });
  },
);

it("retains a completed result through temporary lifecycle unavailability", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const { generation, update, send, dispatch, queued } = fixture();
    const gate = createDeliveryBarrier();
    const mutation = runSessionMutation({
      kind: "reset",
      scope: generation.storePath,
      identities: [generation.sessionKey, generation.sessionId],
      prepare: gate.hold,
      run: () => Promise.resolve(update("result-generation")),
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

it("replays stored results across transcript edits", async () => {
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
    const ids = ["sessions-send:first", "sessions-send:second"];
    for (const id of ids) {
      await enqueue(id);
    }
    update("edited-generation");
    const replay = () =>
      recoverPendingDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        deliver: (params) => deliver({ ...params, deps: { matrix: send } }),
      });
    await replay();
    expect(send.mock.calls.map((call) => call[1])).toEqual(ids);
    expect(await Promise.all(ids.map((id) => loadPendingDelivery(id)))).toEqual([null, null]);
    await enqueue("sessions-send:revoked");
    update("rewound-generation");
    await replay();
    expect(send).toHaveBeenCalledTimes(3);
    expect(await loadPendingDelivery("sessions-send:revoked")).toBeNull();
  });
});

it("refuses queued results when recovery starts after deletion and recreation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { generation, send } = fixture();
    const id = "sessions-send:deleted-conversation";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "old conversation result" }],
        sessionGeneration: generation,
        queuePolicy: "required",
        requiresProducerClaim: true,
      },
      id,
    );
    const target = {
      ...generation,
      target: { canonicalKey: generation.sessionKey, storeKeys: [generation.sessionKey] },
    };
    expect(
      await deleteSessionEntryLifecycle({
        ...target,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      }),
    ).toMatchObject({ deleted: true });
    replaceSessionEntrySync(generation, {
      sessionId: "recreated-session",
      lifecycleRevision: "recreated",
      updatedAt: 3,
    });
    expect(await loadPendingDelivery(id)).not.toBeNull();
    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      deliver: (params) => deliver({ ...params, deps: { matrix: send } }),
    });
    expect(send).not.toHaveBeenCalled();
    expect(await loadPendingDelivery(id)).toBeNull();
  });
});

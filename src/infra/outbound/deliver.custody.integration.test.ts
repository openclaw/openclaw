import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { deliverFollowupDecision } from "../../auto-reply/reply/followup-delivery.js";
import type { AdmittedFollowupTurn } from "../../auto-reply/reply/followup-turn-admission.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { createQueuedDeliveryOwner } from "./deliver-queue-state.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { drainMatrixReconnect } from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import * as queueStorage from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  readQueuedEntry,
} from "./delivery-queue.test-helpers.js";

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => undefined,
  }),
}));

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("follow-up delivery custody", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["ack", "retire"] as const)(
    "keeps a committed %s released when a later observer throws",
    async (transition) => {
      const stateDir = fixtures.tmpDir();
      const queueId = `custody-${transition}`;
      await queueStorage.enqueueDeliveryOnce(
        { channel: "matrix", to: "!room:example", payloads: [{ text: "settled reply" }] },
        queueId,
        stateDir,
      );
      const owner = createQueuedDeliveryOwner({ queueId, stateDir });
      const observed = (async () => {
        try {
          await owner[transition]();
          throw new Error("terminal observer failed");
        } catch (error) {
          throw owner.project(error);
        }
      })();
      await expect(observed).rejects.toMatchObject({
        message: "terminal observer failed",
        queueCustody: "released",
      });
      expect(await loadPendingDeliveries(stateDir)).toEqual([]);
      if (transition === "retire") {
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir)).toBe(
          "failed",
        );
      }
    },
  );

  it.each(["AbortError", "Error"])(
    "leaves one sender after an admitted route fails with %s before dispatch",
    async (name) => {
      const tmpDir = fixtures.tmpDir();
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const accepted: string[] = [];
      let startupClosed = true;
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "matrix",
                config: { listAccountIds: () => [] },
              }),
              message: {
                id: "matrix",
                durableFinal: { capabilities: { text: true } },
                send: {
                  lifecycle: {
                    beforeSendAttempt: async () => {
                      if (startupClosed) {
                        throw Object.assign(new Error("monitor startup closed"), { name });
                      }
                    },
                  },
                  text: async ({ text, onPlatformSendDispatch }) => {
                    await onPlatformSendDispatch?.();
                    accepted.push(text);
                    return {
                      messageId: "recovered",
                      receipt: createMessageReceiptFromOutboundResults({
                        results: [{ channel: "matrix", messageId: "recovered" }],
                        kind: "text",
                      }),
                    };
                  },
                },
              },
            } satisfies ChannelPlugin,
          },
        ]),
      );
      const turn: AdmittedFollowupTurn = {
        runId: "custody-run",
        queued: {
          prompt: "queued",
          enqueuedAt: 1,
          originatingChannel: "matrix",
          originatingTo: "!room:example",
          run: {
            agentId: "agent",
            agentDir: tmpDir,
            sessionId: "session",
            sessionKey: "main",
            sessionFile: `${tmpDir}/session.jsonl`,
            workspaceDir: tmpDir,
            config: {},
            provider: "test",
            model: "test",
            messageProvider: "matrix",
            timeoutMs: 1000,
            blockReplyBreak: "message_end",
          },
        },
        operation: {} as AdmittedFollowupTurn["operation"],
        config: {},
        session: {
          kind: "session",
          key: "main",
          current: () => undefined,
          publish: () => undefined,
          adopt: () => undefined,
        },
        sendPolicy: "allow",
        preflightCompactionApplied: false,
      };
      const nativeSend = vi.fn(async (payload: ReplyPayload) => {
        accepted.push(payload.text ?? "");
      });
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "one queued reply" }] },
        turn,
        runId: "custody-run",
        runFollowup: vi.fn(async () => {}),
        defaults: {
          defaultModel: "test",
          typingMode: "never",
          typing: {
            onReplyStart: vi.fn(async () => {}),
            startTypingLoop: vi.fn(async () => {}),
            startTypingOnText: vi.fn(async () => {}),
            refreshTypingTtl: vi.fn(),
            isActive: () => false,
            markRunComplete: vi.fn(),
            markDispatchIdle: vi.fn(),
            cleanup: vi.fn(),
          },
          opts: { onBlockReply: nativeSend },
        },
      });
      const pending = await loadPendingDeliveries(tmpDir);
      expect(pending).toHaveLength(1);
      startupClosed = false;
      await drainMatrixReconnect({ stateDir: tmpDir, deliver: deliverOutboundPayloads });
      expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
      expect(accepted).toEqual(["one queued reply"]);
      expect(nativeSend).not.toHaveBeenCalled();
    },
  );
});

describe("retired caller delivery settlement", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  function installHeldAdapter(failPreparationOnce = false) {
    const prepared = createDeferred();
    const release = createDeferred();
    let preparationFailurePending = failPreparationOnce;
    const send = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      await ctx.onPlatformSendDispatch?.();
      return {
        messageId: "unexpected-send",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "matrix", messageId: "unexpected-send" }],
          kind: "text",
        }),
      };
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "matrix", config: { listAccountIds: () => [] } }),
            message: {
              id: "matrix",
              durableFinal: { capabilities: { text: true } },
              send: {
                lifecycle: {
                  beforeSendAttempt: async () => {
                    prepared.resolve();
                    await release.promise;
                    if (preparationFailurePending) {
                      preparationFailurePending = false;
                      throw new PlatformMessageNotDispatchedError(
                        "sender preparation unavailable",
                        {
                          cause: new Error("sender runtime unavailable"),
                        },
                      );
                    }
                  },
                },
                text: send,
              },
            },
          },
        },
      ]),
    );
    return { prepared: prepared.promise, release: release.resolve, send };
  }

  it.each([false, true])(
    "finishes interrupted terminal compaction after reopening without another send (bestEffort: %s)",
    async (bestEffort) => {
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const adapter = installHeldAdapter();
      const caller = new AbortController();
      const queueIdReady = createDeferred<string>();
      const compaction = vi
        .spyOn(queueStorage, "finalizeDeliveryFailureSettlement")
        .mockImplementationOnce(() => {
          throw new Error("terminal compaction interrupted");
        });
      const terminals: string[] = [];
      const unsubscribe = onTrustedMessageAuditEvent((event) => {
        if (event.action === "message.outbound.finished") {
          terminals.push(event.outcome);
        }
      });
      const outcome = deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "retired caller message" }],
        queuePolicy: "required",
        bestEffort,
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
      }).then(
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      );
      try {
        const queueId = await queueIdReady.promise;
        await adapter.prepared;
        caller.abort(new Error("message caller retired"));
        adapter.release();
        expect(await outcome).toMatchObject(
          bestEffort
            ? { results: [] }
            : { error: { message: expect.stringContaining("message caller retired") } },
        );
        expect(compaction).toHaveBeenCalledOnce();
        expect(queueStorage.findDeliveryIntentOwner(queueId, stateDir)).toMatchObject({
          status: "failed",
          settlementPending: true,
        });
        expect(
          await queueStorage.claimDeliveryPlatformSendAttempt(queueId, stateDir),
        ).toBeUndefined();
        expect(adapter.send).not.toHaveBeenCalled();
        expect(terminals).toEqual([]);
        compaction.mockRestore();
        stateDatabase.closeOpenClawStateDatabaseForTest();
        await drainMatrixReconnect({ stateDir, deliver: deliverOutboundPayloads });
        expect(await queueStorage.loadUnfinishedDelivery(queueId, stateDir)).toBeNull();
        expect(adapter.send).not.toHaveBeenCalled();
        expect(terminals).toEqual(["failed"]);
      } finally {
        caller.abort();
        adapter.release();
        await outcome;
        unsubscribe();
      }
    },
  );

  it.each([false, true])(
    "does not replay a rejected handoff when its first settlement write fails (bestEffort: %s)",
    async (bestEffort) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const adapter = installHeldAdapter(true);
      const caller = new AbortController();
      const queueIdReady = createDeferred<string>();
      const terminals: string[] = [];
      const unsubscribe = onTrustedMessageAuditEvent((event) => {
        if (event.action === "message.outbound.finished") {
          terminals.push(event.outcome);
        }
      });
      const outcome = deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "retired restart notice" }],
        queuePolicy: "required",
        bestEffort,
        deliveryIntentId: `main-session-restart-recovery:first-write-${bestEffort}`,
        completionRetention: {
          idPrefix: "main-session-restart-recovery:",
          maxAgeMs: 24 * 60 * 60_000,
          maxEntries: 2_000,
        },
        reusePendingDeliveryIntent: true,
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
      }).then(
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      );
      try {
        const queueId = await Promise.race([
          queueIdReady.promise,
          outcome.then((result) => {
            throw new Error(`Delivery settled before queue admission: ${JSON.stringify(result)}`);
          }),
        ]);
        await Promise.race([adapter.prepared, outcome]);
        const firstWrite = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
        const stage = queueStorage.stageDeliveryFailureSettlement;
        const staging = vi
          .spyOn(queueStorage, "stageDeliveryFailureSettlement")
          .mockImplementationOnce((...args) => {
            firstWrite.mockImplementationOnce(() => {
              throw new Error("first settlement write interrupted");
            });
            return stage(...args);
          });
        caller.abort(new Error("message caller retired"));
        adapter.release();
        expect(await outcome).toMatchObject(
          bestEffort
            ? { results: [] }
            : { error: { message: expect.stringContaining("message caller retired") } },
        );
        expect(staging).toHaveBeenCalledOnce();
        expect(staging.mock.calls[0]?.[0].recoveryState).toBe("producer_claimed");
        expect(staging.mock.calls[0]?.[0].platformSendAttemptId).toBeUndefined();
        expect(staging.mock.calls[0]?.[0].platformSendStartedAt).toBeUndefined();
        expect(staging.mock.calls[0]?.[0].deliveryCompletion).toBeUndefined();
        expect(firstWrite.mock.results.filter((result) => result.type === "throw")).toHaveLength(1);
        expect(adapter.send).not.toHaveBeenCalled();
        firstWrite.mockRestore();
        staging.mockRestore();
        stateDatabase.closeOpenClawStateDatabaseForTest();
        vi.setSystemTime(Date.now() + 60_001);
        await drainMatrixReconnect({ stateDir, deliver: deliverOutboundPayloads });
        expect(adapter.send).not.toHaveBeenCalled();
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir)).toBe(
          "failed",
        );
        expect(await queueStorage.loadUnfinishedDelivery(queueId, stateDir)).toBeNull();
        expect(terminals).toEqual(["failed"]);
      } finally {
        caller.abort();
        adapter.release();
        await outcome;
        unsubscribe();
      }
    },
  );

  it("does not project rejection or alter a replacement producer after caller retirement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const completion = await import("./delivery-completion.js");
    vi.spyOn(completion, "markDurableDeliveryQueued").mockResolvedValueOnce({ state: "queued" });
    const reject = vi
      .spyOn(completion, "rejectDurableDelivery")
      .mockResolvedValue({ state: "suppressed" });
    const adapter = installHeldAdapter();
    const caller = new AbortController();
    const queueIdReady = createDeferred<string>();
    const outcome = deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "replacement-owned message" }],
      queuePolicy: "required",
      assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      deliveryCompletion: {
        kind: "pending-final",
        deliveryId: "replacement-completion",
        intentId: "replacement-intent",
        sessionId: "replacement-session",
        sessionKey: "agent:main:matrix:direct:recipient",
        storePath: path.join(stateDir, "sessions.json"),
      },
      onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
    }).then(
      (results) => ({ results }),
      (error: unknown) => ({ error }),
    );
    try {
      const queueId = await queueIdReady.promise;
      await adapter.prepared;
      const originalClaim = readQueuedEntry(stateDir, queueId).producerClaimId;
      // Expire the lease without running its heartbeat so the queue CAS owns the rejection.
      vi.setSystemTime(Date.now() + 60_001);
      const replacementClaim = await queueStorage.claimDeliveryPlatformSendAttempt(
        queueId,
        stateDir,
      );
      expect(replacementClaim).toEqual(expect.any(String));
      expect(replacementClaim).not.toBe(originalClaim);
      const replacement = readQueuedEntry(stateDir, queueId);
      caller.abort(new Error("original caller retired"));
      adapter.release();
      expect(await outcome).toMatchObject({ error: expect.any(Error) });
      expect(reject).not.toHaveBeenCalled();
      expect(adapter.send).not.toHaveBeenCalled();
      expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir)).toBe(
        "pending",
      );
      expect(readQueuedEntry(stateDir, queueId)).toEqual(replacement);
    } finally {
      caller.abort();
      adapter.release();
      await outcome;
    }
  });
});

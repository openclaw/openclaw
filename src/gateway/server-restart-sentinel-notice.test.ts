// Exercises restart-notice retries against the real SQLite outbound queue.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  captureDeliveryQueueStateContext,
  getDeliveryQueueEntryStatus,
} from "../infra/delivery-queue-sqlite.js";
import { runOutboundDeliveryInternal } from "../infra/outbound/deliver-queue.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { attachOutboundDeliveryCommitHook } from "../infra/outbound/delivery-commit-hooks.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../infra/outbound/delivery-queue-media-staging.js";
import * as deliveryQueueStorage from "../infra/outbound/delivery-queue-storage.js";
import {
  loadPendingDelivery,
  markDeliveryPlatformSendAttemptStarted,
} from "../infra/outbound/delivery-queue-storage.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { renderUpdateRunSummary } from "../infra/update-run-notice.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resolveUpdateRunNoticeTarget } from "./update-run-notice-target.js";

const mocks = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(),
  recoveryDeliver: vi.fn(),
  resolveOutboundChannelMessageAdapter: vi.fn(() => undefined),
  sleep: vi.fn(async () => {}),
  hookRunner: {
    hasHooks: vi.fn((name?: string) => name === "message_sent"),
    runMessageSending: vi.fn(async () => undefined),
    runMessageSent: vi.fn(async () => undefined),
  },
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: mocks.sendDurableMessageBatch,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: mocks.recoveryDeliver,
}));

vi.mock("../infra/outbound/channel-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/outbound/channel-resolution.js")>()),
  resolveOutboundChannelMessageAdapter: mocks.resolveOutboundChannelMessageAdapter,
}));

vi.mock("../utils/sleep.js", () => ({ sleep: mocks.sleep }));
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
}));

const { deliverRestartSentinelNotice, enqueueRestartSentinelNotice, sendGatewayLifecycleNotice } =
  await import("./server-restart-sentinel-notice.js");

type DeliveryRequest = {
  deliveryQueueId?: string;
  deliveryQueueStateDir?: string;
  onMessageSentEvent?: (
    event: { success: boolean; content: string; messageId?: string },
    sourceIndex: number,
  ) => void;
};

describe("restart sentinel notice recovery", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let stateDir = "";
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-restart-notice-");
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
    resetPluginRuntimeStateForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  beforeEach(() => {
    closeOpenClawStateDatabaseForTest();
    stateDir = tempDirs.make();
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_SUPERVISOR_MODE"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    mocks.sendDurableMessageBatch.mockReset();
    mocks.recoveryDeliver.mockReset();
    mocks.resolveOutboundChannelMessageAdapter.mockClear();
    mocks.sleep.mockClear();
    mocks.hookRunner.hasHooks.mockClear();
    mocks.hookRunner.hasHooks.mockImplementation((name?: string) => name === "message_sent");
    mocks.hookRunner.runMessageSending.mockReset();
    mocks.hookRunner.runMessageSending.mockResolvedValue(undefined);
    mocks.hookRunner.runMessageSent.mockClear();
  });

  async function enqueueNotice(): Promise<string> {
    const queued = await enqueueRestartSentinelNotice({
      cfg: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "restart complete",
      sessionKey: "agent:main:main",
      revision: 123,
    });
    return queued.id;
  }

  async function deliverNotice(queueId: string): Promise<void> {
    await deliverRestartSentinelNotice({
      deps: {} as never,
      cfg: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "restart complete",
      sessionKey: "agent:main:main",
      summary: "restart summary",
      queueId,
    });
  }

  async function markAttempt(request: unknown): Promise<void> {
    const { deliveryQueueId, deliveryQueueStateDir } = request as DeliveryRequest;
    if (!deliveryQueueId) {
      throw new Error("expected durable delivery queue id");
    }
    await markDeliveryPlatformSendAttemptStarted(deliveryQueueId, deliveryQueueStateDir);
  }

  function queueStatus(queueId: string): string | undefined {
    return getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir);
  }

  function sendLifecycleNotice(deliveryIntentId: string) {
    return sendGatewayLifecycleNotice({
      cfg: {},
      deps: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "update starting",
      sessionKey: "agent:main:main",
      deliveryIntentId,
    });
  }

  it.each(["owner", "non-owner", "no-owners", "control-ui"] as const)(
    "sends the four update milestones only to a configured owner (%s)",
    async (destination) => {
      const { createUpdateRunNotifier } = await import("./update-run-notice.runtime.js");
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "matrix", messageId: "notice" }),
              },
            }),
          },
        ]),
      );
      mocks.sendDurableMessageBatch.mockImplementation(async (request) => {
        await markAttempt(request);
        return { status: "sent", results: [{ channel: "matrix", messageId: "notice" }] };
      });
      const cfg = {
        commands: {
          ownerAllowFrom: destination === "no-owners" ? [] : ["matrix:@owner:example.org"],
        },
      };
      const sessionKey = "agent:main:matrix:direct:contact";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "update-contact",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: {
              channel: "matrix",
              to: destination === "owner" ? "@owner:example.org" : "@contact:example.org",
            },
          }),
        },
      );
      let run = createUpdateRun({
        trigger: destination === "control-ui" ? "control-ui" : "chat",
        before: { version: "2026.9.1" },
        target: { version: "2026.9.2" },
        origin: destination === "control-ui" ? {} : { sessionKey },
      });
      const target = await resolveUpdateRunNoticeTarget({ cfg, sessionKey: run.origin.sessionKey });
      expect.soft(target.kind).toBe(destination === "owner" ? "route" : "none");
      const notify = await createUpdateRunNotifier(run, () => cfg, {});
      await notify(run, "ack");
      await notify(run, "ack");
      for (const phase of ["staging", "validating", "activating"] as const) {
        run = recordUpdateRunPhase(run.runId, phase);
        await notify(run, "activating");
      }
      await notify(run, "activating");
      run = recordUpdateRunPhase(run.runId, "verifying");
      run = recordUpdateRunVerification(run.runId, { booted: true, runningVersion: "2026.9.2" });
      const successor = await createUpdateRunNotifier(run, () => cfg, {});
      await successor(run, "verifying");
      await successor(run, "verifying");
      run = finishUpdateRun(run.runId, { status: "succeeded", after: { version: "2026.9.2" } });
      await successor(run, "finished");
      await notify(run, "finished");
      expect(
        mocks.sendDurableMessageBatch.mock.calls.map(([request]) => request.payloads[0].text),
      ).toEqual(
        destination === "owner"
          ? [
              "⬆️ Updating OpenClaw… You'll get a message here when it's done.",
              "⏳ Restarting OpenClaw…",
              "🔁 Checking that OpenClaw is ready…",
              renderUpdateRunSummary(run),
            ]
          : [],
      );
      expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(destination === "owner");
      if (destination !== "owner") {
        for (const kind of ["ack", "activating", "verifying", "finished"]) {
          expect(
            await deliveryQueueStorage.findDeliveryIntentOwner(`update-run-${kind}:${run.runId}`),
          ).toBeNull();
        }
      }
      expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
    },
  );

  it.each(["sent", "suppressed", "failed", "throw", "ack-failed"] as const)(
    "reports %s lifecycle delivery without starting inline recovery",
    async (outcome) => {
      const queueId = `update-run-ack:${outcome}`;
      if (outcome === "ack-failed") {
        vi.spyOn(deliveryQueueStorage, "ackDelivery").mockRejectedValueOnce(
          new Error("queue acknowledgement unavailable"),
        );
      }
      mocks.sendDurableMessageBatch.mockImplementationOnce(async () => {
        if (outcome === "throw") {
          throw new Error("transport unavailable");
        }
        return outcome === "failed"
          ? { status: outcome, error: new Error("transport unavailable") }
          : {
              status: outcome === "ack-failed" ? "sent" : outcome,
              results:
                outcome === "suppressed" ? [] : [{ channel: "whatsapp", messageId: "ack-1" }],
            };
      });
      const sent = outcome === "sent" || outcome === "ack-failed";
      await expect(sendLifecycleNotice(queueId)).resolves.toBe(sent);
      expect(mocks.sendDurableMessageBatch).toHaveBeenCalledOnce();
      expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
      expect(queueStatus(queueId)).toBe(
        outcome === "sent" || outcome === "suppressed" ? "completed" : "pending",
      );
      if (outcome === "ack-failed") {
        expect(await loadPendingDelivery(queueId)).toMatchObject({
          recoveryState: "unknown_after_send",
        });
      }
    },
  );

  it.each(["send", "after-commit"] as const)(
    "bounds a blocked %s while its work owner retains settlement",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const queueId = `update-run-ack:${phase}-timeout`;
      const started = createDeferredCore();
      const finish = createDeferredCore();
      const completed = createDeferredCore();
      const work = new AsyncWorkScope();
      const pause = async () => {
        started.resolve();
        await finish.promise;
        completed.resolve();
      };
      const result = { channel: "whatsapp" as const, messageId: "late-ack" };
      if (phase === "send") {
        mocks.sendDurableMessageBatch.mockImplementationOnce(async () => {
          await pause();
          return { status: "sent", results: [result] };
        });
      } else {
        mocks.sendDurableMessageBatch.mockResolvedValueOnce({
          status: "sent",
          results: [attachOutboundDeliveryCommitHook(result, pause)],
        });
      }
      let settled = false;
      const send = work
        .track(() => sendLifecycleNotice(queueId))
        .finally(() => {
          settled = true;
        });
      await started.promise;
      let drained = false;
      let draining: Promise<void> | undefined;
      try {
        if (phase === "after-commit") {
          expect(queueStatus(queueId)).toBe("completed");
        }
        await vi.advanceTimersByTimeAsync(9_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(send).resolves.toBe(phase === "after-commit");
        expect(queueStatus(queueId)).toBe(phase === "send" ? "pending" : "completed");
        draining = work.drain().then(() => {
          drained = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(drained).toBe(false);
      } finally {
        finish.resolve();
        await (draining ?? work.drain());
        await completed.promise;
        if (phase === "send") {
          await vi.waitFor(() => expect(queueStatus(queueId)).toBe("completed"));
        }
      }
      expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
    },
  );

  it("finishes a real durable send under the admitted RPC root after restart admission closes", async () => {
    const { sendDurableMessageBatchCore } = await import("../channels/message/send.js");
    mocks.sendDurableMessageBatch.mockImplementation(sendDurableMessageBatchCore);
    mocks.recoveryDeliver.mockImplementation(runOutboundDeliveryInternal);
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const sendText = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      return { channel: "matrix" as const, messageId: "ack-during-drain" };
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );
    const root = tryBeginGatewayRootWorkAdmission("ws:update.run");
    if (!root) {
      throw new Error("expected update RPC root admission");
    }
    const queueId = "update-run-ack:admitted-root";
    const send = root
      .run(async () => {
        markGatewayRestartDraining();
        return await sendGatewayLifecycleNotice({
          cfg: {},
          deps: {},
          channel: "matrix",
          to: "!operator:example",
          message: "update starting",
          deliveryIntentId: queueId,
        });
      })
      .finally(root.release);
    try {
      await started.promise;
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(tryBeginGatewayRootWorkAdmission("unrelated")).toBeNull();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(await loadPendingDelivery(queueId)).not.toBeNull();
    } finally {
      finish.resolve();
    }

    await expect(send).resolves.toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(await loadPendingDelivery(queueId)).toBeNull();
    expect(queueStatus(queueId)).toBe("completed");
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each([
    ["enqueue", "state directory"],
    ["enqueue", "supervisor mode"],
    ["preparation", "state directory"],
    ["preparation", "supervisor mode"],
    ["transport", "state directory"],
    ["transport", "supervisor mode"],
  ] as const)(
    "retains notice custody through %s when ambient %s changes",
    async (phase, changed) => {
      setTestEnvValue("OPENCLAW_SUPERVISOR_MODE", "external");
      claimOpenClawStateOwnership("notice-custody-fixture", { env: process.env });
      const context = captureDeliveryQueueStateContext(stateDir);
      const replacement = tempDirs.make();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const pause = async () => {
        entered.resolve();
        await resume.promise;
      };
      mocks.hookRunner.hasHooks.mockImplementation((name?: string) => name === "message_sending");
      mocks.hookRunner.runMessageSending.mockImplementationOnce(async () => {
        if (phase !== "transport") {
          await pause();
        }
        return undefined;
      });
      const sendText = vi.fn(async () => {
        if (phase === "transport") {
          await pause();
        }
        return { channel: "matrix" as const, messageId: "retained-notice" };
      });
      if (phase !== "enqueue") {
        const { sendDurableMessageBatchCore } = await import("../channels/message/send.js");
        mocks.sendDurableMessageBatch.mockImplementation(sendDurableMessageBatchCore);
        mocks.recoveryDeliver.mockImplementation(runOutboundDeliveryInternal);
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "matrix",
              source: "test",
              plugin: createOutboundTestPlugin({
                id: "matrix",
                outbound: { deliveryMode: "direct", sendText },
              }),
            },
          ]),
        );
      }
      const queueId = "lifecycle-retained-context";
      const pending =
        phase === "enqueue"
          ? enqueueNotice()
          : sendGatewayLifecycleNotice({
              cfg: {},
              deps: {},
              channel: "matrix",
              to: "!operator:example",
              message: "update starting",
              deliveryIntentId: queueId,
            });
      await entered.promise;
      setTestEnvValue(
        changed === "state directory" ? "OPENCLAW_STATE_DIR" : "OPENCLAW_SUPERVISOR_MODE",
        changed === "state directory" ? replacement : "",
      );
      resume.resolve();
      const result = await pending;
      if (phase === "enqueue") {
        if (typeof result !== "string") {
          throw new Error("Expected the queued notice id");
        }
        expect(await loadPendingDelivery(result, undefined, context)).toMatchObject({
          to: "+15550002",
          maxRetries: 45,
          completionRetention: "permanent",
        });
        expect(await loadPendingDelivery(result, replacement)).toBeNull();
        expect(mocks.sendDurableMessageBatch).not.toHaveBeenCalled();
      } else {
        expect(result).toBe(true);
        expect(sendText).toHaveBeenCalledOnce();
        expect(
          await deliveryQueueStorage.findDeliveryIntentOwner(queueId, undefined, context),
        ).toMatchObject({ status: "completed" });
        expect(await loadPendingDelivery(queueId, replacement)).toBeNull();
      }
    },
  );

  it.each(["retry recovery", "permanent rejection"] as const)(
    "retains explicitly captured restart custody through %s",
    async (outcome) => {
      const { sendDurableMessageBatchCore } = await import("../channels/message/send.js");
      mocks.sendDurableMessageBatch.mockImplementation(sendDurableMessageBatchCore);
      mocks.recoveryDeliver.mockImplementation(runOutboundDeliveryInternal);
      setTestEnvValue("OPENCLAW_SUPERVISOR_MODE", "external");
      claimOpenClawStateOwnership("restart-recovery-fixture", { env: process.env });
      const context = captureDeliveryQueueStateContext(stateDir);
      const sendText = vi
        .fn()
        .mockRejectedValueOnce(
          new PlatformMessageNotDispatchedError("retry synthetic transport", {
            cause: new Error("not dispatched"),
            retryable: outcome === "retry recovery",
          }),
        )
        .mockResolvedValue({ channel: "matrix", messageId: "recovered-context" });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "matrix",
              outbound: { deliveryMode: "direct", sendText },
            }),
          },
        ]),
      );
      const request = {
        cfg: {},
        channel: "matrix",
        to: "!operator:example",
        message: "restart complete",
        sessionKey: "agent:main:main",
        revision: 123,
      };
      const queued = await enqueueRestartSentinelNotice(request, context);
      const replacement = tempDirs.make();
      setTestEnvValue("OPENCLAW_STATE_DIR", replacement);
      setTestEnvValue("OPENCLAW_SUPERVISOR_MODE", "");
      await expect(
        deliverRestartSentinelNotice(
          { ...request, deps: {}, summary: "synthetic restart", queueId: queued.id },
          context,
        ),
      ).resolves.toBe(false);
      expect(sendText).toHaveBeenCalledTimes(outcome === "retry recovery" ? 2 : 1);
      expect(
        await deliveryQueueStorage.findDeliveryIntentOwner(queued.id, undefined, context),
      ).toMatchObject({ status: outcome === "retry recovery" ? "completed" : "failed" });
      expect(await loadPendingDelivery(queued.id, replacement)).toBeNull();
    },
  );

  it("serializes stable notice preparation before modifiers can run twice", async () => {
    mocks.hookRunner.hasHooks.mockImplementation((name?: string) => name === "message_sending");
    const modifierEntered = createDeferredCore();
    const releaseModifier = createDeferredCore();
    mocks.hookRunner.runMessageSending.mockImplementationOnce(async () => {
      modifierEntered.resolve();
      await releaseModifier.promise;
      return undefined;
    });
    const request = {
      cfg: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "restart complete",
      sessionKey: "agent:main:main",
      revision: 123,
    };

    const first = enqueueRestartSentinelNotice(request);
    const pending = [first];
    try {
      await Promise.race([modifierEntered.promise, first]);
      expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
      let secondSettled = false;
      const second = enqueueRestartSentinelNotice(request).finally(() => {
        secondSettled = true;
      });
      pending.push(second);
      await Promise.resolve();
      expect(secondSettled).toBe(false);
      expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
      releaseModifier.resolve();
      await expect(first).resolves.toEqual({
        id: "restart-sentinel-notice:agent:main:main:123",
        created: true,
      });
      await expect(second).resolves.toEqual({
        id: "restart-sentinel-notice:agent:main:main:123",
        created: false,
      });
      await expect(enqueueRestartSentinelNotice(request)).resolves.toEqual(await second);
      expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
    } finally {
      releaseModifier.resolve();
      await Promise.allSettled(pending);
    }
  });

  it.each(["sent", "retryable", "ambiguous", "permanent", "exhausted"] as const)(
    "settles restart notice %s delivery before publishing terminal hooks",
    async (outcome) => {
      const queueId = await enqueueNotice();
      const statusesAtHook: Array<string | undefined> = [];
      mocks.hookRunner.runMessageSent.mockImplementationOnce(async () => {
        statusesAtHook.push(queueStatus(queueId));
      });
      const failure = () =>
        outcome === "ambiguous"
          ? new Error("platform outcome unknown")
          : new PlatformMessageNotDispatchedError("transport not dispatched", {
              cause: new Error("synthetic transport failure"),
              retryable: outcome !== "permanent",
            });
      mocks.sendDurableMessageBatch.mockImplementationOnce(async (request: DeliveryRequest) => {
        await markAttempt(request);
        if (outcome !== "sent") {
          return { status: "failed", error: failure() };
        }
        request.onMessageSentEvent?.(
          {
            success: true,
            content: "restart complete",
            messageId: "notice-1",
          },
          0,
        );
        return { status: "sent", results: [{ channel: "whatsapp", messageId: "notice-1" }] };
      });
      if (outcome === "exhausted") {
        mocks.recoveryDeliver.mockImplementation(async (request) => {
          await markAttempt(request);
          throw failure();
        });
      } else if (outcome === "retryable") {
        mocks.recoveryDeliver.mockResolvedValueOnce([
          { channel: "whatsapp", messageId: "recovered-1" },
        ]);
      }
      await deliverNotice(queueId);
      expect(mocks.sendDurableMessageBatch).toHaveBeenCalledOnce();
      expect(mocks.recoveryDeliver).toHaveBeenCalledTimes(
        outcome === "retryable" ? 1 : outcome === "exhausted" ? 44 : 0,
      );
      expect(await loadPendingDelivery(queueId)).toBeNull();
      expect(queueStatus(queueId)).toBe(
        outcome === "sent" || outcome === "retryable" ? "completed" : "failed",
      );
      if (outcome === "sent") {
        await vi.waitFor(() => expect(mocks.hookRunner.runMessageSent).toHaveBeenCalledOnce());
        expect(statusesAtHook).toEqual(["completed"]);
      }
    },
  );
});

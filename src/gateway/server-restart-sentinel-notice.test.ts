// Exercises restart-notice retries against the real SQLite outbound queue.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-sqlite.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.test-support.js";
import { runOutboundDeliveryInternal } from "../infra/outbound/deliver-queue.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { attachOutboundDeliveryCommitHook } from "../infra/outbound/delivery-commit-hooks.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../infra/outbound/delivery-queue-media-staging.js";
import * as queue from "../infra/outbound/delivery-queue-storage.js";
import * as runs from "../infra/update-run-ledger.js";
import { renderUpdateRunSummary } from "../infra/update-run-notice.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as admission from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resolveUpdateRunNoticeTarget } from "./update-run-notice-target.js";

const {
  sendDurableMessageBatch: sendBatch,
  recoveryDeliver: recover,
  hookRunner: hooks,
  ...mocks
} = vi.hoisted(() => ({
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

// mock-isolation: Keep real queue ownership while replacing external transport.
vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: sendBatch,
}));

// mock-isolation: Control recovery outcomes without sending external messages.
vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: recover,
}));

vi.mock("../infra/outbound/channel-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/outbound/channel-resolution.js")>()),
  resolveOutboundChannelMessageAdapter: mocks.resolveOutboundChannelMessageAdapter,
}));

vi.mock("../utils/sleep.js", () => ({ sleep: mocks.sleep }));
// mock-isolation: Observe test hooks without invoking installed plugin hooks.
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hooks,
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

const noticeRequest = (channel = "whatsapp", to = "+15550002") => ({
  cfg: {},
  channel,
  to,
  message: "restart complete",
  sessionKey: "agent:main:main",
  revision: 123,
});
function useMatrixPlugin(sendText: ChannelOutboundAdapter["sendText"]) {
  const id = "matrix";
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: id,
        source: "test",
        plugin: createOutboundTestPlugin({ id, outbound: { deliveryMode: "direct", sendText } }),
      },
    ]),
  );
}
async function useRealDelivery() {
  const { sendDurableMessageBatchCore } = await import("../channels/message/send.js");
  sendBatch.mockImplementation(sendDurableMessageBatchCore);
  recover.mockImplementation(runOutboundDeliveryInternal);
}
function capturedCustody(stateDir: string, owner: string) {
  setTestEnvValue("OPENCLAW_SUPERVISOR_MODE", "external");
  claimOpenClawStateOwnership(owner, { env: process.env });
  return captureDeliveryQueueStateContext(stateDir);
}
function pauseGate() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pause = async () => {
    entered.resolve();
    await release.promise;
    return undefined;
  };
  return { entered: entered.promise, release: release.resolve, pause };
}
const notDispatched = (retryable: boolean) =>
  new PlatformMessageNotDispatchedError("synthetic transport failure", {
    cause: new Error("not dispatched"),
    retryable,
  });

describe("restart sentinel notice recovery", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let stateDir = "";
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-restart-notice-");
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    admission.resetGatewayWorkAdmission();
    resetPluginRuntimeStateForTest();
    await stateDb.closeOpenClawStateDatabaseAsync();
    stateDb.closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  beforeEach(() => {
    stateDb.closeOpenClawStateDatabaseForTest();
    stateDir = tempDirs.make();
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_SUPERVISOR_MODE"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    sendBatch.mockReset();
    recover.mockReset();
    mocks.resolveOutboundChannelMessageAdapter.mockClear();
    mocks.sleep.mockClear();
    hooks.hasHooks.mockClear();
    hooks.hasHooks.mockImplementation((name?: string) => name === "message_sent");
    hooks.runMessageSending.mockReset();
    hooks.runMessageSending.mockResolvedValue(undefined);
    hooks.runMessageSent.mockClear();
  });

  async function enqueueNotice(): Promise<string> {
    const queued = await enqueueRestartSentinelNotice(noticeRequest());
    return queued.id;
  }

  async function deliverNotice(queueId: string): Promise<void> {
    await deliverRestartSentinelNotice({
      ...noticeRequest(),
      deps: {},
      summary: "restart summary",
      queueId,
    });
  }

  async function markAttempt(request: unknown): Promise<void> {
    const { deliveryQueueId, deliveryQueueStateDir } = request as DeliveryRequest;
    if (!deliveryQueueId) {
      throw new Error("expected durable delivery queue id");
    }
    await queue.markDeliveryPlatformSendAttemptStarted(deliveryQueueId, deliveryQueueStateDir);
  }

  function queueStatus(queueId: string): string | undefined {
    return getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir);
  }

  function sendLifecycleNotice(deliveryIntentId: string, matrix = false) {
    return sendGatewayLifecycleNotice({
      cfg: {},
      deps: {},
      channel: matrix ? "matrix" : "whatsapp",
      to: matrix ? "!operator:example" : "+15550002",
      message: "update starting",
      ...(matrix ? {} : { sessionKey: "agent:main:main" }),
      deliveryIntentId,
    });
  }

  it.each(["owner", "non-owner", "no-owners", "control-ui"] as const)(
    "sends the four update milestones only to a configured owner (%s)",
    async (destination) => {
      const { createUpdateRunNotifier } = await import("./update-run-notice.runtime.js");
      useMatrixPlugin(async () => ({ channel: "matrix", messageId: "notice" }));
      sendBatch.mockImplementation(async (request) => {
        await markAttempt(request);
        return { status: "sent", results: [{ channel: "matrix", messageId: "notice" }] };
      });
      const ownerAllowFrom = destination === "no-owners" ? [] : ["matrix:@owner:example.org"];
      const cfg = { commands: { ownerAllowFrom } };
      setRuntimeConfigSnapshot(cfg);
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
      let run = runs.createUpdateRun({
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
        run = runs.recordUpdateRunPhase(run.runId, phase);
        await notify(run, "activating");
      }
      await notify(run, "activating");
      run = runs.recordUpdateRunPhase(run.runId, "verifying");
      run = runs.recordUpdateRunVerification(run.runId, {
        booted: true,
        runningVersion: "2026.9.2",
      });
      const successor = await createUpdateRunNotifier(run, () => cfg, {});
      await successor(run, "verifying");
      await successor(run, "verifying");
      run = runs.finishUpdateRun(run.runId, {
        status: "succeeded",
        after: { version: "2026.9.2" },
      });
      await successor(run, "finished");
      await notify(run, "finished");
      expect(sendBatch.mock.calls.map(([request]) => request.payloads[0].text)).toEqual(
        destination === "owner"
          ? [
              "⬆️ Updating OpenClaw… You'll get a message here when it's done.",
              "⏳ Restarting OpenClaw…",
              "🔁 Checking that OpenClaw is ready…",
              renderUpdateRunSummary(run),
            ]
          : [],
      );
      expect(runs.getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(
        destination === "owner",
      );
      if (destination !== "owner") {
        for (const kind of ["ack", "activating", "verifying", "finished"]) {
          expect(await queue.findDeliveryIntentOwner(`update-run-${kind}:${run.runId}`)).toBeNull();
        }
      }
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it.each(["sent", "suppressed", "failed", "throw", "ack-failed"] as const)(
    "reports %s lifecycle delivery without starting inline recovery",
    async (outcome) => {
      const queueId = `update-run-ack:${outcome}`;
      if (outcome === "ack-failed") {
        vi.spyOn(queue, "ackDelivery").mockRejectedValueOnce(
          new Error("queue acknowledgement unavailable"),
        );
      }
      sendBatch.mockImplementationOnce(async () => {
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
      expect(sendBatch).toHaveBeenCalledOnce();
      expect(recover).not.toHaveBeenCalled();
      expect(queueStatus(queueId)).toBe(
        outcome === "sent" || outcome === "suppressed" ? "completed" : "pending",
      );
      if (outcome === "ack-failed") {
        expect(await queue.loadPendingDelivery(queueId)).toMatchObject({
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
        sendBatch.mockImplementationOnce(async () => {
          await pause();
          return { status: "sent", results: [result] };
        });
      } else {
        sendBatch.mockResolvedValueOnce({
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
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it("finishes a real durable send under the admitted RPC root after restart admission closes", async () => {
    await useRealDelivery();
    const gate = pauseGate();
    const sendText = vi.fn(async () => {
      await gate.pause();
      return { channel: "matrix" as const, messageId: "ack-during-drain" };
    });
    useMatrixPlugin(sendText);
    const root = admission.tryBeginGatewayRootWorkAdmission("ws:update.run");
    if (!root) {
      throw new Error("expected update RPC root admission");
    }
    const queueId = "update-run-ack:admitted-root";
    const send = root
      .run(async () => {
        admission.markGatewayRestartDraining();
        return await sendLifecycleNotice(queueId, true);
      })
      .finally(root.release);
    try {
      await gate.entered;
      expect(admission.isGatewayWorkAdmissionClosed()).toBe(true);
      expect(admission.tryBeginGatewayRootWorkAdmission("unrelated")).toBeNull();
      expect(admission.getActiveGatewayRootWorkCount()).toBe(1);
      expect(await queue.loadPendingDelivery(queueId)).not.toBeNull();
    } finally {
      gate.release();
    }

    await expect(send).resolves.toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(await queue.loadPendingDelivery(queueId)).toBeNull();
    expect(queueStatus(queueId)).toBe("completed");
    expect(admission.getActiveGatewayRootWorkCount()).toBe(0);
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
      const context = capturedCustody(stateDir, "notice-custody-fixture");
      const replacement = tempDirs.make();
      const gate = pauseGate();
      hooks.hasHooks.mockImplementation((name?: string) => name === "message_sending");
      hooks.runMessageSending.mockImplementationOnce(async () => {
        if (phase !== "transport") {
          await gate.pause();
        }
        return undefined;
      });
      const sendText = vi.fn(async () => {
        if (phase === "transport") {
          await gate.pause();
        }
        return { channel: "matrix" as const, messageId: "retained-notice" };
      });
      if (phase !== "enqueue") {
        await useRealDelivery();
        useMatrixPlugin(sendText);
      }
      const queueId = "lifecycle-retained-context";
      const pending = phase === "enqueue" ? enqueueNotice() : sendLifecycleNotice(queueId, true);
      await gate.entered;
      setTestEnvValue(
        changed === "state directory" ? "OPENCLAW_STATE_DIR" : "OPENCLAW_SUPERVISOR_MODE",
        changed === "state directory" ? replacement : "",
      );
      gate.release();
      const result = await pending;
      if (phase === "enqueue") {
        if (typeof result !== "string") {
          throw new Error("Expected the queued notice id");
        }
        expect(await queue.loadPendingDelivery(result, undefined, context)).toMatchObject({
          to: "+15550002",
          maxRetries: 45,
          completionRetention: "permanent",
        });
        expect(await queue.loadPendingDelivery(result, replacement)).toBeNull();
        expect(sendBatch).not.toHaveBeenCalled();
      } else {
        expect(result).toBe(true);
        expect(sendText).toHaveBeenCalledOnce();
        expect(await queue.findDeliveryIntentOwner(queueId, undefined, context)).toMatchObject({
          status: "completed",
        });
        expect(await queue.loadPendingDelivery(queueId, replacement)).toBeNull();
      }
    },
  );

  it.each(["retry recovery", "permanent rejection"] as const)(
    "retains explicitly captured restart custody through %s",
    async (outcome) => {
      await useRealDelivery();
      const context = capturedCustody(stateDir, "restart-recovery-fixture");
      const sendText = vi
        .fn()
        .mockRejectedValueOnce(notDispatched(outcome === "retry recovery"))
        .mockResolvedValue({ channel: "matrix", messageId: "recovered-context" });
      useMatrixPlugin(sendText);
      const request = noticeRequest("matrix", "!operator:example");
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
      expect(await queue.findDeliveryIntentOwner(queued.id, undefined, context)).toMatchObject({
        status: outcome === "retry recovery" ? "completed" : "failed",
      });
      expect(await queue.loadPendingDelivery(queued.id, replacement)).toBeNull();
    },
  );

  it("serializes stable notice preparation before modifiers can run twice", async () => {
    hooks.hasHooks.mockImplementation((name?: string) => name === "message_sending");
    const gate = pauseGate();
    hooks.runMessageSending.mockImplementationOnce(gate.pause);
    const request = noticeRequest();

    const first = enqueueRestartSentinelNotice(request);
    const pending = [first];
    try {
      await Promise.race([gate.entered, first]);
      expect(hooks.runMessageSending).toHaveBeenCalledOnce();
      let secondSettled = false;
      const second = enqueueRestartSentinelNotice(request).finally(() => {
        secondSettled = true;
      });
      pending.push(second);
      await Promise.resolve();
      expect(secondSettled).toBe(false);
      expect(hooks.runMessageSending).toHaveBeenCalledOnce();
      gate.release();
      const id = "restart-sentinel-notice:agent:main:main:123";
      await expect(first).resolves.toEqual({ id, created: true });
      await expect(second).resolves.toEqual({ id, created: false });
      await expect(enqueueRestartSentinelNotice(request)).resolves.toEqual(await second);
      expect(hooks.runMessageSending).toHaveBeenCalledOnce();
    } finally {
      gate.release();
      await Promise.allSettled(pending);
    }
  });

  it.each(["sent", "retryable", "ambiguous", "permanent", "exhausted"] as const)(
    "settles restart notice %s delivery before publishing terminal hooks",
    async (outcome) => {
      const queueId = await enqueueNotice();
      const statusesAtHook: Array<string | undefined> = [];
      hooks.runMessageSent.mockImplementationOnce(async () => {
        statusesAtHook.push(queueStatus(queueId));
      });
      const failure = () =>
        outcome === "ambiguous"
          ? new Error("platform outcome unknown")
          : notDispatched(outcome !== "permanent");
      sendBatch.mockImplementationOnce(async (request: DeliveryRequest) => {
        await markAttempt(request);
        if (outcome !== "sent") {
          return { status: "failed", error: failure() };
        }
        request.onMessageSentEvent?.(
          { success: true, content: "restart complete", messageId: "notice-1" },
          0,
        );
        return { status: "sent", results: [{ channel: "whatsapp", messageId: "notice-1" }] };
      });
      if (outcome === "exhausted") {
        recover.mockImplementation(async (request) => {
          await markAttempt(request);
          throw failure();
        });
      } else if (outcome === "retryable") {
        recover.mockResolvedValueOnce([{ channel: "whatsapp", messageId: "recovered-1" }]);
      }
      await deliverNotice(queueId);
      expect(sendBatch).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledTimes(
        outcome === "retryable" ? 1 : outcome === "exhausted" ? 44 : 0,
      );
      expect(await queue.loadPendingDelivery(queueId)).toBeNull();
      expect(queueStatus(queueId)).toBe(
        outcome === "sent" || outcome === "retryable" ? "completed" : "failed",
      );
      if (outcome === "sent") {
        await vi.waitFor(() => expect(hooks.runMessageSent).toHaveBeenCalledOnce());
        expect(statusesAtHook).toEqual(["completed"]);
      }
    },
  );
});

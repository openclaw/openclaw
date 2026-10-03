import { expect, it, vi } from "vitest";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  messageAuditMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  automaticDirectReplyConfig,
  dispatchReplyFromConfig,
  createReplyOperation,
  replyRunRegistry,
  setNoAbort,
  messageAuditEvents,
} from "./dispatch-from-config.test-harness.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { buildTestCtx } from "./test-ctx.js";

// Registered in the original suite so its shared fixtures and lifecycle remain authoritative.
export function registerBackgroundDispatchAdmissionTests(): void {
  it("defers an idle-only Telegram topic automation while a reply operation is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:3731";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "user-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async () => ({ text: "idle automation should not run" }) satisfies ReplyPayload,
    );

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: sessionKey,
        ChatType: "group",
        IsForum: true,
        MessageSid: "scheduled-check",
        MessageThreadId: 3731,
        TransportThreadId: 3731,
        To: "telegram:-1003774691294:topic:3731",
        BodyForAgent: "Check the automation state",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyOptions: {
        scheduledAutomation: {
          job: { ...makeCronJob({}), idleOnly: true },
          assertCurrent: () => {},
        },
      },
      replyResolver,
    });

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "reply_operation_active",
      }),
    );
    activeOperation.complete();
  });

  it("preempts background work before resolving a visible Telegram turn", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:direct:background-preemption";
    const backgroundAdmission = await admitReplyTurn({
      sessionKey,
      sessionId: "background-session",
      kind: "background",
      resetTriggered: false,
    });
    expect(backgroundAdmission.status).toBe("owned");
    if (backgroundAdmission.status !== "owned") {
      return;
    }
    const backgroundOperation = backgroundAdmission.operation;
    const cancel = vi.fn(() => backgroundOperation.complete());
    backgroundOperation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    backgroundOperation.setPhase("running");
    sessionStoreMocks.currentEntry = {
      sessionId: "background-session",
      updatedAt: Date.now(),
    };
    let backgroundWasAbortedBeforeReply = false;
    const replyResolver = vi.fn(async () => {
      backgroundWasAbortedBeforeReply = backgroundOperation.abortSignal.aborted;
      return { text: "visible reply" } satisfies ReplyPayload;
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        BodyForAgent: "answer this now",
      }),
      cfg: automaticDirectReplyConfig,
      dispatcher: createDispatcher(),
      replyOptions: {
        turnAdoptionLifecycle: {
          onAdopted: async () => {},
          onDeferred: vi.fn(),
          onSettled: vi.fn(),
        },
      },
      replyResolver,
    });

    expect(result.queuedFinal).toBe(true);
    expect(backgroundWasAbortedBeforeReply).toBe(true);
    expect(backgroundOperation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_supersession",
    });
    expect(cancel).toHaveBeenCalledWith("superseded");
    expect(replyResolver).toHaveBeenCalledOnce();
  });
}

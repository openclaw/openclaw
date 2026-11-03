import { expect, it, vi } from "vitest";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { createInboundTurn, createSessionTurn } from "./get-reply-run.test-support.js";
import { REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, createReplyOperation } from "./reply-run-registry.js";

export function registerHeartbeatPreemptionCases({
  runPrepared,
  requireRunReplyAgentCall,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}): void {
  it("queues interrupt-mode turns behind admitted recovery after heartbeat preemption", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const storePath = "/tmp/recovery-admission-sessions.json";
    const recoveryAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["session-key", "session-recovery-starting"],
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      assertAllowed: () => {},
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-embedded-heartbeat",
    );
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
      "drained",
    );

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-recovery-starting",
          storePath,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireRunReplyAgentCall();
      expect(call.isActive).toBe(true);
      expect(call.shouldSteer).toBe(false);
      expect(call.shouldFollowup).toBe(true);
    } finally {
      recoveryAdmission.release();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
        "not-heartbeat",
      );
    }
  });
  it("drains an embedded heartbeat hidden by the visible pre-dispatch operation", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const operation = createReplyOperation({
      sessionId: "session-pre-dispatch-heartbeat",
      sessionKey: "session-key",
      turnKind: "visible",
      resetTriggered: false,
    });
    const route = { OriginatingChannel: "telegram", OriginatingTo: "user:1" };
    let embeddedRunActive = true;
    let releaseDrain: (() => void) | undefined;
    const drainBarrier = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "steer" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation(() =>
      embeddedRunActive ? "session-pre-dispatch-heartbeat" : undefined,
    );
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockImplementation(
      async () => {
        await drainBarrier;
        embeddedRunActive = false;
        return "drained";
      },
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockImplementation(
      () => embeddedRunActive,
    );
    vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).mockImplementation(async () => {
      await drainBarrier;
      embeddedRunActive = false;
      return true;
    });

    try {
      const runPromise = runPrepared({
        isNewSession: false,
        sessionId: "session-pre-dispatch-heartbeat",
        opts: { replyOperation: operation } as never,
        ctx: { ...createInboundTurn("answer this now", "telegram", "direct"), ...route },
        sessionCtx: { ...createSessionTurn("answer this now", "telegram", "direct"), ...route },
      });

      await vi.waitFor(
        () => {
          expect(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).toHaveBeenCalledWith(
            "session-pre-dispatch-heartbeat",
            REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          );
        },
        { timeout: 1_000 },
      );
      expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
      expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();

      releaseDrain?.();
      await expect(runPromise).resolves.toEqual({ text: "ok" });
    } finally {
      releaseDrain?.();
      operation.complete();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReset()
        .mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun)
        .mockReset()
        .mockResolvedValue("not-heartbeat");
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReset().mockReturnValue(false);
      vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd)
        .mockReset()
        .mockResolvedValue(true);
    }

    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("queues an exec completion behind its heartbeat instead of preempting it", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const body = "Exec completed (health-check, code 0) :: OK";
    const route = { OriginatingChannel: "telegram", OriginatingTo: "user:1" };
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "followup" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-embedded-heartbeat",
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValue(true);
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
      "drained",
    );

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-embedded-heartbeat",
          opts: { internalEventExecution: { onStarted: vi.fn(), onTerminal: vi.fn() } } as never,
          ctx: { ...createInboundTurn(body, "telegram", "direct"), ...route },
          sessionCtx: { ...createSessionTurn(body, "telegram", "direct"), ...route },
        }),
      ).resolves.toEqual({ text: "ok" });

      expect(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).not.toHaveBeenCalled();
      expect(requireRunReplyAgentCall()).toMatchObject({
        shouldSteer: false,
        shouldFollowup: true,
        isActive: true,
      });
    } finally {
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValue(false);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
        "not-heartbeat",
      );
    }
  });
}

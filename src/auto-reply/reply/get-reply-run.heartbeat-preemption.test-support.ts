import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { createProviderSurface } from "./get-reply-run.test-support.js";
import { REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, createReplyOperation } from "./reply-run-registry.js";

type ReplyRunParams = Parameters<typeof runPreparedReply>[0];

export function registerHeartbeatPreemptionCases({
  runPrepared,
  requireRunReplyAgentCall,
  turn,
}: {
  runPrepared: (overrides?: Partial<ReplyRunParams>) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
  turn: (body: string, common: ReplyRunParams["ctx"]) => Pick<ReplyRunParams, "ctx" | "sessionCtx">;
}): void {
  it.each([
    { kind: "completion", keyed: true },
    { kind: "completion", keyed: false },
    { kind: "visible", keyed: true },
    { kind: "visible", keyed: false },
  ])(
    "preempts a real native heartbeat only for $kind turns (keyed: $keyed)",
    async ({ kind, keyed }) => {
      const native = await import("../../agents/embedded-agent-runner/runs.js");
      const runtime = await import("../../agents/embedded-agent.runtime.js");
      const { createEmbeddedRunHandle } =
        await import("../../agents/embedded-agent-runner/runs.test-support.js");
      const queueSettings = await import("./queue/settings-runtime.js");
      const sessionId = "session-native-heartbeat";
      const sessionKey = keyed ? "session-key" : undefined;
      const preempted = createDeferred();
      const preemptByVisibleTurn = vi.fn(() => {
        preempted.resolve();
        return true;
      });
      const handle = { ...createEmbeddedRunHandle(), preemptByVisibleTurn };
      native.setActiveEmbeddedRun(sessionId, handle, sessionKey);
      vi.mocked(runtime.resolveActiveEmbeddedRunSessionId).mockImplementation(
        native.resolveActiveEmbeddedRunHandleSessionId,
      );
      vi.mocked(runtime.resolveActiveEmbeddedRunSessionIdBySessionFile).mockReturnValue(sessionId);
      vi.mocked(runtime.isEmbeddedAgentRunActive).mockImplementation(
        native.isEmbeddedAgentRunActive,
      );
      vi.mocked(runtime.preemptAndDrainEmbeddedHeartbeatRun).mockImplementation(
        native.preemptAndDrainEmbeddedHeartbeatRun,
      );
      vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "followup" });
      const completion = kind === "completion";
      const running = runPrepared({
        sessionKey,
        sessionId,
        isNewSession: false,
        opts: completion
          ? { internalEventExecution: { onStarted: vi.fn(), onTerminal: vi.fn() } }
          : {},
        ...turn(completion ? "Exec completed (health-check, code 0) :: OK" : "answer this now", {
          ...createProviderSurface("telegram"),
          ChatType: "direct",
        }),
      });
      try {
        if (completion) {
          await awaitGateBeforeSettlement(
            running,
            preempted.promise,
            "Exec completion superseded its originating heartbeat",
          );
          expect(preemptByVisibleTurn).not.toHaveBeenCalled();
          expect(native.isEmbeddedAgentRunActive(sessionId)).toBe(true);
          expect(requireRunReplyAgentCall()).toMatchObject({
            shouldSteer: false,
            shouldFollowup: true,
            isActive: true,
          });
        } else {
          await awaitGateBeforeSettlement(
            preempted.promise,
            running,
            "Visible turn bypassed the heartbeat",
          );
          expect(runReplyAgent).not.toHaveBeenCalled();
          native.clearActiveEmbeddedRun(sessionId, handle);
          await expect(running).resolves.toEqual({ text: "ok" });
          expect(preemptByVisibleTurn).toHaveBeenCalledOnce();
          expect(requireRunReplyAgentCall()).toMatchObject({
            shouldSteer: false,
            shouldFollowup: false,
            isActive: false,
          });
        }
      } finally {
        native.clearActiveEmbeddedRun(sessionId, handle);
        await running.catch(() => {});
        vi.mocked(runtime.resolveActiveEmbeddedRunSessionId).mockReset().mockReturnValue(undefined);
        vi.mocked(runtime.resolveActiveEmbeddedRunSessionIdBySessionFile)
          .mockReset()
          .mockReturnValue(undefined);
        vi.mocked(runtime.isEmbeddedAgentRunActive).mockReset().mockReturnValue(false);
        vi.mocked(runtime.preemptAndDrainEmbeddedHeartbeatRun)
          .mockReset()
          .mockResolvedValue("not-heartbeat");
      }
    },
  );

  it("drains an embedded heartbeat hidden by the visible pre-dispatch operation", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const operation = createReplyOperation({
      sessionId: "session-pre-dispatch-heartbeat",
      sessionKey: "session-key",
      turnKind: "visible",
      resetTriggered: false,
    });
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
        ...turn("answer this now", {
          ...createProviderSurface("telegram"),
          ChatType: "direct",
          OriginatingChannel: "telegram",
          OriginatingTo: "user:1",
        }),
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
}

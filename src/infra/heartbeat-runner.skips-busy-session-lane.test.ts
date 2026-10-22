// Covers heartbeat drops decided by the target session's mailbox admission.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { preemptAndDrainEmbeddedHeartbeatRun } from "../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing as embeddedRunTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { runReplyAgent } from "../auto-reply/reply/agent-runner-run.js";
import {
  createTestFollowupRun,
  createTestQueueSettings,
} from "../auto-reply/reply/agent-runner.test-fixtures.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { resolveReplyOperationRunState } from "../auto-reply/reply/reply-operation-run-state.js";
import { createMockTypingController } from "../auto-reply/reply/test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearCronJobActive, markCronJobActive, resetCronActiveJobs } from "../cron/active-jobs.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { isSessionRunActive } from "../sessions/session-controller.queries.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { getAgentEventLifecycleGeneration } from "./agent-events.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import {
  bindHeartbeatReply,
  observeHeartbeatSend,
} from "./heartbeat-runner.boundary-test-support.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  type HeartbeatReplySpy,
  seedHeartbeatScratchForTest,
  seedMainSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } from "./heartbeat-wake.js";
import { resetSystemEventsForTest, enqueueSystemEvent, peekSystemEvents } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));
let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
beforeAll(() => {
  previousRegistry = getActivePluginRegistry();
  const send = async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: { deliveryMode: "direct", sendText: send, sendMedia: send },
        }),
      },
    ]),
  );
});
afterAll(() => {
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});
beforeEach(() => {
  resetHeartbeatEventsForTest();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetSystemEventsForTest();
  resetCronActiveJobs();
});
afterEach(() => resetHeartbeatEventsForTest());

type RunOverrides = Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg">;
type SessionSeed = Partial<Parameters<typeof seedMainSessionStore>[2]>;
function createCase({ storePath, replySpy }: { storePath: string; replySpy: HeartbeatReplySpy }) {
  bindHeartbeatReply(replySpy);
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    agents: {
      defaults: { heartbeat: { every: "30m", target: "last" }, model: { primary: "test/model" } },
    },
    channels: { telegram: { enabled: true, botToken: "fake", allowFrom: ["123"] } },
  };
  return {
    cfg,
    storePath,
    replySpy,
    seed: (entry: SessionSeed = {}) =>
      seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123",
        ...entry,
      }),
    run: (overrides: RunOverrides = {}) =>
      runHeartbeatOnce({
        cfg,
        ...overrides,
      }),
  };
}
function heartbeatCase(test: (fixture: ReturnType<typeof createCase>) => Promise<void>) {
  return () => withTempHeartbeatSandbox((sandbox) => test(createCase(sandbox)));
}
function expectBusy(
  result: Awaited<ReturnType<typeof runHeartbeatOnce>>,
  replySpy: HeartbeatReplySpy,
  reason: string = HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
) {
  expect(result).toEqual({ status: "skipped", reason });
  expect(getLastHeartbeatEvent()).toMatchObject({ ...result, durationMs: expect.any(Number) });
  expect(replySpy).not.toHaveBeenCalled();
}
function recoveryDelivery(
  runId = "restart-recovery-run",
  lifecycleGeneration = getAgentEventLifecycleGeneration(),
): SessionSeed {
  return {
    abortedLastRun: false,
    restartRecoveryDeliveryRunId: "restart-recovery-run",
    restartRecoveryRuns: [{ runId, lifecycleGeneration }],
  };
}
// Holds a running controller turn; "cron" holds unrelated automation work instead.
function holdBusy(target: string) {
  if (target === "cron") {
    const marker = markCronJobActive("unrelated-job");
    return () => clearCronJobActive("unrelated-job", marker);
  }
  const operation = createReplyOperation({
    sessionKey: target,
    sessionId: "busy-session",
    resetTriggered: false,
  });
  operation.setPhase("running");
  return () => operation.complete();
}

describe("heartbeat runner skips when target session is busy", () => {
  it.for([
    ["interrupted", "scheduled", true],
    ["admitted", "immediate", true],
    ["current-delivery", "scheduled", true],
    ["current-delivery", "manual", false],
    ["previous-lifecycle", "scheduled", false],
    ["different-run", "scheduled", false],
  ] as const)("honors restart ownership %s", async ([owner, intent, busy]) =>
    heartbeatCase(async ({ seed, run, replySpy }) => {
      const admitted = owner === "admitted";
      await seed(
        owner === "interrupted" || admitted
          ? {
              ...(admitted ? {} : { status: "interrupted" as const }),
              abortedLastRun: !admitted,
              mainRestartRecovery: {
                cycleId: "restart-cycle",
                revision: admitted ? 2 : 1,
                chargedAttempts: admitted ? 1 : 0,
                ...(admitted
                  ? {
                      foregroundClaims: {
                        lifecycleGeneration: getAgentEventLifecycleGeneration(),
                        tokens: ["recovery-owner"],
                      },
                    }
                  : {}),
              },
            }
          : recoveryDelivery(
              owner === "different-run" ? "another-restart-recovery-run" : "restart-recovery-run",
              owner === "previous-lifecycle"
                ? "previous-gateway-lifecycle"
                : getAgentEventLifecycleGeneration(),
            ),
      );
      if (owner !== "interrupted" && !admitted) {
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      }
      const result = await run({ intent });
      if (busy) {
        expectBusy(result, replySpy);
      } else {
        expect(result.status).toBe("ran");
        expect(replySpy).toHaveBeenCalledOnce();
      }
    })(),
  );

  it.each([
    { content: "# Heartbeat scratch\n\n## Tasks\n\n", reason: "empty-heartbeat-file" },
    { content: "- Check status\n", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT },
  ])("handles scheduled scratch before busy admission: $reason", async ({ content, reason }) =>
    heartbeatCase(async ({ seed, run, replySpy }) => {
      const release = holdBusy(await seed());
      await seedHeartbeatScratchForTest({ content });
      try {
        expectBusy(
          await run({
            source: "interval",
            intent: "scheduled",
            reason: "interval",
            scheduledEveryMs: 30 * 60_000,
          }),
          replySpy,
          reason,
        );
      } finally {
        release();
      }
    })(),
  );

  it.each([
    { busy: "nothing", dropped: false },
    { busy: "another session of the same agent", dropped: false },
    { busy: "unrelated automation", dropped: false },
    { busy: "the target session", dropped: true },
  ])("drops a scheduled heartbeat only for its own session: $busy", async ({ busy, dropped }) =>
    heartbeatCase(async ({ seed, run, replySpy }) => {
      const sessionKey = await seed();
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const release =
        busy === "nothing"
          ? undefined
          : holdBusy(
              busy === "unrelated automation"
                ? "cron"
                : dropped
                  ? sessionKey
                  : "agent:main:telegram:alerts",
            );
      try {
        const result = await run({ intent: "scheduled" });
        if (dropped) {
          expectBusy(result, replySpy);
        } else {
          expect(result.status).toBe("ran");
          expect(replySpy).toHaveBeenCalledOnce();
        }
      } finally {
        release?.();
      }
    })(),
  );

  it.each(["another session", "own session"] as const)(
    "delivers targeted exec failure unless its own session is busy: %s",
    async (busy) =>
      heartbeatCase(async ({ cfg, seed, run, replySpy }) => {
        cfg.agents!.defaults!.heartbeat = { every: "0m", target: "last" };
        const sessionKey = await seed();
        const text = "Exec failed (ci-watch, code 1) :: GitHub connection closed";
        enqueueSystemEvent(text, { sessionKey, contextKey: "exec:ci-watch" });
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
        const release = holdBusy(
          busy === "own session" ? sessionKey : "agent:main:telegram:alerts",
        );
        try {
          const result = await run({
            source: "exec-event",
            intent: "event",
            reason: "exec-event",
            sessionKey,
          });
          if (busy === "own session") {
            expectBusy(result, replySpy);
            expect(peekSystemEvents(sessionKey)).toEqual([text]);
          } else {
            expect(result.status).toBe("ran");
            expect(replySpy.mock.calls[0]?.[0].Body).toContain(text);
            expect(peekSystemEvents(sessionKey)).toEqual([]);
          }
        } finally {
          release();
        }
      })(),
  );

  it(
    "suppresses delivery when a visible turn supersedes a finalizing heartbeat",
    heartbeatCase(async ({ seed, run, replySpy }) => {
      const sessionKey = await seed();
      let preempt: ReturnType<typeof vi.fn<() => boolean>> | undefined;
      replySpy.mockImplementationOnce(
        async (_ctx, options: InternalGetReplyOptions | undefined) => {
          const operation = options?.replyOperation;
          const runState = resolveReplyOperationRunState(options);
          if (!operation || !runState) {
            throw new Error("Expected admitted heartbeat operation");
          }
          const sessionId = operation.sessionId;
          preempt = vi.fn(() => operation.supersede());
          const handle = {
            ...createEmbeddedRunHandle({ isAbortable: false }),
            preemptByVisibleTurn: preempt,
          };
          runState.agentTurn = "ok";
          runState.agentTurnOwner = operation;
          operation.freezeAbort();
          setActiveEmbeddedRun(sessionId, handle, sessionKey);
          const drained = preemptAndDrainEmbeddedHeartbeatRun(sessionId, 1_000);
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
          await expect(drained).resolves.toBe("drained");
          operation.complete();
          return { text: "Background work finished." };
        },
      );
      const telegram = observeHeartbeatSend("telegram");
      expect(await run()).toEqual({ status: "skipped", reason: "preempted" });
      expect(preempt).toHaveBeenCalledOnce();
      expect(telegram).not.toHaveBeenCalled();
    }),
  );

  it.each([
    {
      source: "exec-event" as const,
      intent: "event" as const,
      reason: "exec-event",
      contextKey: "exec:late-run",
      text: "Exec completed (late-run, code 0) :: result",
    },
    {
      source: "cron" as const,
      intent: "immediate" as const,
      reason: "cron:late-run",
      contextKey: "cron:late-run",
      text: "Check the scheduled report",
    },
  ])(
    "retains $source work when foreground execution wins late admission",
    async ({ source, intent, reason, contextKey, text }) =>
      heartbeatCase(async ({ cfg, storePath, seed, run, replySpy }) => {
        const sessionKey = await seed();
        enqueueSystemEvent(text, { sessionKey, contextKey });
        replySpy.mockImplementationOnce(
          async (ctx, options: InternalGetReplyOptions | undefined) => {
            const operation = options?.replyOperation;
            if (!operation) {
              throw new Error("Expected admitted heartbeat operation");
            }
            // The backend becomes active after monitor preflight and outer dispatch admission.
            const handle = createEmbeddedRunHandle();
            setActiveEmbeddedRun(operation.sessionId, handle, sessionKey);
            try {
              const reply = await runReplyAgent({
                commandBody: text,
                followupRun: createTestFollowupRun({
                  sessionId: operation.sessionId,
                  sessionKey,
                  config: cfg,
                }),
                queueKey: sessionKey,
                resolvedQueue: createTestQueueSettings(),
                shouldSteer: false,
                shouldFollowup: false,
                isActive: isSessionRunActive(operation.sessionId),
                opts: options,
                typing: createMockTypingController(),
                sessionKey,
                storePath,
                defaultModel: "test/model",
                resolvedVerboseLevel: "off",
                isNewSession: false,
                blockStreamingEnabled: false,
                resolvedBlockStreamingBreak: "message_end",
                sessionCtx: ctx,
                shouldInjectGroupIntro: false,
                typingMode: "never",
                replyOperation: operation,
              });
              expect(resolveReplyOperationRunState(options)?.admission).toEqual({
                status: "skipped",
                reason: "active-run",
              });
              return reply;
            } finally {
              clearActiveEmbeddedRun(operation.sessionId, handle, sessionKey);
            }
          },
        );
        const wake = { source, reason, intent, sessionKey };
        const result = await run(wake);

        expect(replySpy).toHaveBeenCalledOnce();
        expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
        expect(getLastHeartbeatEvent()).toMatchObject(result);
        expect(peekSystemEvents(sessionKey)).toEqual([text]);

        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
        expect((await run(wake)).status).toBe("ran");
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(peekSystemEvents(sessionKey)).toEqual([]);
      })(),
  );

  it(
    "does not infer admission rejection from a replacement run after an empty heartbeat",
    heartbeatCase(async ({ seed, run, replySpy }) => {
      const sessionKey = await seed();
      const heartbeatEntered = createDeferredCore();
      const replacementQueued = createDeferredCore();
      const releaseReplacement = createDeferredCore();
      replySpy.mockImplementation(async (_ctx, options: InternalGetReplyOptions | undefined) => {
        const runState = resolveReplyOperationRunState(options);
        if (!runState || !options?.replyOperation) {
          throw new Error("Expected heartbeat reply operation state");
        }
        runState.admission = { status: "owned" };
        heartbeatEntered.resolve();
        await replacementQueued.promise;
        options.replyOperation.complete();
        return undefined;
      });
      const heartbeat = run();
      await heartbeatEntered.promise;
      // The replacement queues on the session mailbox like a real visible turn and
      // takes the slot as soon as the empty heartbeat releases its claim.
      const replacement = withSessionTurn(
        { sessionKey, sessionId: "racing-visible-session" },
        async (operation) => {
          operation?.setPhase("running");
          await releaseReplacement.promise;
        },
      );
      replacementQueued.resolve();
      try {
        expect((await heartbeat).status).toBe("ran");
        expect(isSessionRunActive("racing-visible-session")).toBe(true);
        expect(replySpy).toHaveBeenCalledOnce();
      } finally {
        releaseReplacement.resolve();
        await replacement;
      }
    }),
  );

  it.for(["recent final", "acknowledgement", "stale final"] as const)(
    "handles pending delivery: %s",
    async (kind) =>
      heartbeatCase(async ({ cfg, seed, run, replySpy }) => {
        const stale = kind === "stale final";
        const ack = kind === "acknowledgement";
        if (stale) {
          cfg.agents!.defaults!.heartbeat = { every: "30m", target: "telegram" };
        }
        const timestamp = Date.now() - (stale ? 60_000 : 0);
        await seed({
          ...(ack ? { lastProvider: "heartbeat", lastTo: "heartbeat" } : {}),
          ...(stale ? { lastTo: "default-heartbeat-target" } : {}),
          updatedAt: timestamp,
          pendingFinalDelivery: {
            kind: "replayable",
            text: stale
              ? "private prior user answer"
              : ack
                ? "HEARTBEAT_OK short"
                : "The requested report is ready.",
            createdAt: timestamp,
          },
        });
        if (kind === "recent final") {
          expectBusy(await run(), replySpy);
          return;
        }
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
        const telegram = stale ? observeHeartbeatSend("telegram") : undefined;
        expect((await run()).status).toBe("ran");
        expect(replySpy).toHaveBeenCalledOnce();
        if (stale) {
          expect(replySpy.mock.calls[0]?.[1]).toMatchObject({ isHeartbeat: true });
          expect(telegram).not.toHaveBeenCalled();
        }
      })(),
  );
});

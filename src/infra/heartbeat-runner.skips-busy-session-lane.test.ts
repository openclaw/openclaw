import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as embeddedRuns from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { runReplyAgent } from "../auto-reply/reply/agent-runner-run.js";
import * as replyFixtures from "../auto-reply/reply/agent-runner.test-fixtures.js";
import { resolveReplyOperationRunState } from "../auto-reply/reply/reply-operation-run-state.js";
import * as replyRuns from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunRegistryTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { createMockTypingController } from "../auto-reply/reply/test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import * as cronJobs from "../cron/active-jobs.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { CommandLane } from "../process/lanes.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { getAgentEventLifecycleGeneration } from "./agent-events.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  type HeartbeatReplySpy,
  seedHeartbeatScratchForTest,
  seedMainSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import * as heartbeatWake from "./heartbeat-wake.js";
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
  cronJobs.resetCronActiveJobs();
  replyRunRegistryTesting.resetReplyRunRegistry();
});

type RunResult = Awaited<ReturnType<typeof runHeartbeatOnce>>;
type RunOverrides = Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps">;
type SessionSeed = Partial<Parameters<typeof seedMainSessionStore>[2]>;
function createCase({ storePath, replySpy }: { storePath: string; replySpy: HeartbeatReplySpy }) {
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    agents: {
      defaults: { heartbeat: { every: "30m", target: "last" }, model: { primary: "test/model" } },
    },
    channels: { telegram: { enabled: true, botToken: "fake", allowFrom: ["123"] } },
  };
  const seed = (entry: SessionSeed = {}) =>
    seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "123",
      ...entry,
    });
  return {
    cfg,
    storePath,
    replySpy,
    seed,
    expectBusy: (result: RunResult, reason = heartbeatWake.HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT) => {
      expect(result).toEqual({ status: "skipped", reason });
      expect(getLastHeartbeatEvent()).toMatchObject({ ...result, durationMs: expect.any(Number) });
      expect(replySpy).not.toHaveBeenCalled();
    },
    expectRan: (result: RunResult) => {
      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
    },
    seedPending: (text: string, ageMs = 0, entry: SessionSeed = {}) =>
      seed({
        ...entry,
        updatedAt: Date.now() - ageMs,
        pendingFinalDelivery: { kind: "replayable", text, createdAt: Date.now() - ageMs },
      }),
    run: (overrides: RunOverrides = {}, deps: Partial<HeartbeatDeps> = {}) =>
      runHeartbeatOnce({
        cfg,
        ...overrides,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
          ...deps,
        },
      }),
  };
}
const it = test.extend<{ hb: ReturnType<typeof createCase> }>({
  hb: async ({ task: _task }, use) => {
    try {
      await withTempHeartbeatSandbox((sandbox) => use(createCase(sandbox)));
    } finally {
      resetHeartbeatEventsForTest();
    }
  },
});
function admittedReply(options: Parameters<HeartbeatReplySpy>[1]) {
  return {
    operation: expectDefined(options?.replyOperation, "admitted heartbeat operation"),
    runState: expectDefined(resolveReplyOperationRunState(options), "heartbeat run state"),
  };
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
function markHeartbeatWaitOwners(...jobIds: string[]) {
  const markers = jobIds
    .map((jobId) => cronJobs.markCronJobActive(jobId))
    .filter((marker): marker is NonNullable<typeof marker> => marker !== undefined);
  const releases = markers.map((marker) => cronJobs.markCronJobWaitingForHeartbeat(marker));
  return () => {
    for (const release of releases) {
      release();
    }
    for (const marker of markers) {
      cronJobs.clearCronJobActive(marker.jobId, marker);
    }
  };
}

it("defers scheduled work during restart recovery", async ({ hb }) => {
  await hb.seed({
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "restart-cycle", revision: 1, chargedAttempts: 0 },
  });
  hb.expectBusy(await hb.run({ intent: "scheduled" }));
});

it("defers work behind the current recovery owner", async ({ hb }) => {
  await hb.seed({
    abortedLastRun: false,
    mainRestartRecovery: {
      cycleId: "restart-cycle",
      revision: 2,
      chargedAttempts: 1,
      foregroundClaims: {
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        tokens: ["recovery-owner"],
      },
    },
  });
  hb.expectBusy(await hb.run({ intent: "immediate" }));
});

it.for([
  { owner: "current", intent: "scheduled", blocked: true },
  { owner: "current", intent: "manual", blocked: false },
  { owner: "previous-lifecycle", intent: "scheduled", blocked: false },
  { owner: "different-run", intent: "scheduled", blocked: false },
] as const)(
  "restart delivery owner $owner under $intent",
  async ({ owner, intent, blocked }, { hb }) => {
    await hb.seed(
      recoveryDelivery(
        owner === "different-run" ? "another-restart-recovery-run" : "restart-recovery-run",
        owner === "previous-lifecycle"
          ? "previous-gateway-lifecycle"
          : getAgentEventLifecycleGeneration(),
      ),
    );
    hb.replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
    const result = await hb.run({ intent });
    if (blocked) {
      hb.expectBusy(result);
    } else {
      hb.expectRan(result);
    }
  },
);

it.for([
  { content: "# Heartbeat scratch\n\n## Tasks\n\n", reason: "empty-heartbeat-file" },
  { content: "- Check status\n", reason: heartbeatWake.HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT },
])("handles scheduled scratch before busy queues: $reason", async ({ content, reason }, { hb }) => {
  await hb.seed();
  await seedHeartbeatScratchForTest({ content });
  hb.expectBusy(
    await hb.run(
      {
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        scheduledEveryMs: 30 * 60_000,
      },
      { getQueueSize: (lane) => (lane === CommandLane.Main ? 2 : 0) },
    ),
    reason,
  );
});

it.for([false, true])(
  "exempts waiting cron owners but blocks unrelated work: %s",
  async (unrelated, { hb }) => {
    await hb.seed();
    hb.replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
    const release = markHeartbeatWaitOwners("report-a", "report-b");
    if (unrelated) {
      cronJobs.markCronJobActive("unrelated-job");
    }
    try {
      const result = await hb.run({ source: "cron", reason: "heartbeat-task:report-a" });
      if (unrelated) {
        hb.expectBusy(result, heartbeatWake.HEARTBEAT_SKIP_CRON_IN_PROGRESS);
      } else {
        hb.expectRan(result);
      }
    } finally {
      release();
    }
  },
);

it("returns cron-in-progress when cron lanes have queued work", async ({ hb }) => {
  await hb.seed();
  hb.expectBusy(
    await hb.run({}, { getQueueSize: (lane) => Number(lane === CommandLane.Cron) }),
    heartbeatWake.HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  );
});

it.for(["active-cron", "session", "session-reply", "session-embedded"] as const)(
  "delivers targeted exec failure unless its own session is busy: %s",
  async (busy, { hb }) => {
    hb.cfg.agents!.defaults!.heartbeat = { every: "0m", target: "last" };
    const sessionKey = await hb.seed();
    const text = "Exec failed (ci-watch, code 1) :: GitHub connection closed";
    enqueueSystemEvent(text, { sessionKey, contextKey: "exec:ci-watch" });
    hb.replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
    const activeCron =
      busy === "active-cron" ? cronJobs.markCronJobActive("unrelated-job") : undefined;
    try {
      const result = await hb.run(
        { source: "exec-event", intent: "event", reason: "exec-event", sessionKey },
        {
          getQueueSize: (lane) => Number(busy === "session" && lane === `session:${sessionKey}`),
          listActiveReplyRunSessionKeys: () => (busy === "session-reply" ? [sessionKey] : []),
          isReplyRunActive: (key) => busy === "session-reply" && key === sessionKey,
          listActiveEmbeddedRunSessionKeys: () => (busy === "session-embedded" ? [sessionKey] : []),
        },
      );
      if (busy.startsWith("session")) {
        hb.expectBusy(result);
        expect(peekSystemEvents(sessionKey)).toEqual([text]);
      } else {
        hb.expectRan(result);
        expect(hb.replySpy.mock.calls[0]?.[0].Body).toContain(text);
        expect(peekSystemEvents(sessionKey)).toEqual([]);
      }
    } finally {
      if (activeCron) {
        cronJobs.clearCronJobActive(activeCron.jobId, activeCron);
      }
    }
  },
);

it("defers while a reply owns the drained session", async ({ hb }) => {
  const sessionKey = await hb.seed();
  const operation = replyRuns.createReplyOperation({
    sessionKey,
    sessionId: "active-reply-session",
    resetTriggered: false,
  });
  operation.setPhase("running");
  try {
    hb.expectBusy(await hb.run());
  } finally {
    operation.complete();
  }
});

it("suppresses a finalizing heartbeat superseded by a visible turn", async ({ hb }) => {
  const sessionKey = await hb.seed();
  let preempt: ReturnType<typeof vi.fn<() => boolean>> | undefined;
  hb.replySpy.mockImplementationOnce(async (_ctx, options) => {
    const { operation, runState } = admittedReply(options);
    const sessionId = operation.sessionId;
    preempt = vi.fn(() => operation.supersede());
    const handle = {
      ...createEmbeddedRunHandle({ isAbortable: false }),
      preemptByVisibleTurn: preempt,
    };
    runState.agentTurn = "ok";
    runState.agentTurnOwner = operation;
    operation.freezeAbort();
    embeddedRuns.setActiveEmbeddedRun(sessionId, handle, sessionKey);
    const drained = embeddedRuns.preemptAndDrainEmbeddedHeartbeatRun(sessionId, 1_000);
    embeddedRuns.clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    await expect(drained).resolves.toBe("drained");
    operation.complete();
    return { text: "Background work finished." };
  });
  const telegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
  expect(await hb.run({}, { telegram })).toEqual({ status: "skipped", reason: "preempted" });
  expect(preempt).toHaveBeenCalledOnce();
  expect(telegram).not.toHaveBeenCalled();
});

it("retains exec work after losing late admission", async ({ hb }) => {
  const sessionKey = await hb.seed();
  const text = "Exec completed (late-run, code 0) :: result";
  enqueueSystemEvent(text, { sessionKey, contextKey: "exec:late-run" });
  hb.replySpy.mockImplementationOnce(async (ctx, options) => {
    const { operation } = admittedReply(options);
    const handle = createEmbeddedRunHandle();
    embeddedRuns.setActiveEmbeddedRun(operation.sessionId, handle, sessionKey);
    try {
      const reply = await runReplyAgent({
        commandBody: text,
        followupRun: replyFixtures.createTestFollowupRun({
          sessionId: operation.sessionId,
          sessionKey,
          config: hb.cfg,
        }),
        queueKey: sessionKey,
        resolvedQueue: replyFixtures.createTestQueueSettings(),
        shouldSteer: false,
        shouldFollowup: false,
        isActive: embeddedRuns.isEmbeddedAgentRunActive(operation.sessionId),
        opts: options,
        typing: createMockTypingController(),
        sessionKey,
        storePath: hb.storePath,
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
      embeddedRuns.clearActiveEmbeddedRun(operation.sessionId, handle, sessionKey);
    }
  });
  const wake = {
    source: "exec-event",
    reason: "exec-event",
    intent: "event",
    sessionKey,
  } as const;
  const result = await hb.run(wake);
  expect(hb.replySpy).toHaveBeenCalledOnce();
  expect(result).toEqual({
    status: "skipped",
    reason: heartbeatWake.HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  });
  expect(getLastHeartbeatEvent()).toMatchObject(result);
  expect(peekSystemEvents(sessionKey)).toEqual([text]);
  hb.replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
  expect((await hb.run(wake)).status).toBe("ran");
  expect(hb.replySpy).toHaveBeenCalledTimes(2);
  expect(peekSystemEvents(sessionKey)).toEqual([]);
});

it("ignores a replacement run after an admitted empty reply", async ({ hb }) => {
  const sessionKey = await hb.seed();
  let operation: ReturnType<typeof replyRuns.createReplyOperation> | undefined;
  hb.replySpy.mockImplementation(async (_ctx, options) => {
    const { operation: admitted, runState } = admittedReply(options);
    runState.admission = { status: "owned" };
    admitted.complete();
    await replyRuns.waitForReplyRunSuccessorAdmission(sessionKey, null);
    operation = replyRuns.createReplyOperation({
      sessionKey,
      sessionId: "racing-visible-session",
      resetTriggered: false,
    });
    operation.setPhase("running");
    return undefined;
  });
  try {
    hb.expectRan(await hb.run());
  } finally {
    operation?.complete();
  }
});

it("defers behind a recent pending final", async ({ hb }) => {
  await hb.seedPending("The requested report is ready.");
  hb.expectBusy(await hb.run());
});

it("allows a recent acknowledgement within its fixed budget", async ({ hb }) => {
  await hb.seedPending("HEARTBEAT_OK short", 0, {
    lastProvider: "heartbeat",
    lastTo: "heartbeat",
  });
  hb.replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
  hb.expectRan(await hb.run());
});

it("never replays a stale pending final", async ({ hb }) => {
  hb.cfg.agents!.defaults!.heartbeat = { every: "30m", target: "telegram" };
  await hb.seedPending("private prior user answer", 60_000, {
    lastTo: "default-heartbeat-target",
  });
  hb.replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
  const telegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "default" });
  hb.expectRan(await hb.run({}, { telegram }));
  expect(hb.replySpy.mock.calls[0]?.[1]).toMatchObject({ isHeartbeat: true });
  expect(telegram).not.toHaveBeenCalled();
});

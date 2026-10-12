import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { commitMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-store.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  clearAgentRunContext,
  hasLiveAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "./chat-abort.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { prepareGatewayRunShutdown } from "./server-run-shutdown.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { projectGatewaySessionActiveRun } from "./session-utils-display.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

const cfg = { agents: { entries: { main: {} } } };
let state: OpenClawTestState;
let storePath: string;

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "restart-drain-session-settlement" });
  setRuntimeConfigSnapshot(cfg, cfg);
  storePath = state.statePath("agents", "main", "sessions", "sessions.json");
});

afterAll(async () => {
  rotateAgentEventLifecycleGeneration();
  await state?.cleanup();
});

it("persists recovery when restart cancellation precedes shutdown marking", async () => {
  const childKey = "agent:main:dashboard:child";
  const mainKey = "agent:main:dashboard:main";
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const persist = vi.fn(persistGatewaySessionLifecycleEvent);
  const harness = createAgentEventTestHarness({
    persistGatewaySessionLifecycleEventForEvent: persist,
  });
  harness.clearAgentRunContext.mockImplementation(clearAgentRunContext);
  const unsubscribe = subscribeAgentEvents(harness.handler);
  const registrations: Array<ReturnType<typeof registerChatAbortController>> = [];
  const joinPersistence = async () => {
    await unsubscribe.drain();
    await Promise.all(persist.mock.results.map((result) => result.value));
  };
  const read = (sessionKey: string) =>
    expectDefined(
      loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
      "persisted session",
    );
  try {
    for (const [sessionKey, spawnDepth] of [
      [childKey, 1],
      [mainKey, 0],
    ] as const) {
      const runId = `${sessionKey}:run`;
      const sessionId = `${sessionKey}:session`;
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId, updatedAt: 1_000, spawnDepth },
      );
      registerAgentRunContext(runId, { sessionKey, sessionId, agentId: "main" });
      const registration = registerChatAbortController({
        chatAbortControllers,
        runId,
        sessionId,
        sessionKey,
        agentId: "main",
        now: 1_000,
        timeoutMs: 60_000,
      });
      registrations.push(registration);
      registration.markExecutionStarted();
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      await joinPersistence();
      expect(read(sessionKey).lifecycleRunId).toBe(runId);
      expect.soft(read(sessionKey).status).toBeUndefined();
      const active = resolveVisibleActiveSessionRunState({
        context: { chatAbortControllers },
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
        agentId: "main",
      });
      expect(projectGatewaySessionActiveRun(active, read(sessionKey).status)).toEqual({
        status: "running",
        hasActiveRun: true,
      });
    }
    registrations[1]!.controller.abort(createAgentRunRestartAbortError());
    const warnings: string[] = [];
    await prepareGatewayRunShutdown({
      resolveGatewayContext: () => undefined,
      restart: true,
      timeoutMs: 0,
      warnings,
      getPendingReplyCount: () => 0,
      chatAbortControllers,
      chatQueuedTurns: new Map(),
      chatRunState: harness.chatRunState,
      agentRunSeq: harness.agentRunSeq,
      removeChatRun: () => undefined,
      broadcast: harness.broadcast,
      nodeSendToSession: harness.nodeSendToSession,
      markMainSessionsAbortedForRestart: async (params) => {
        await markRestartAbortedMainSessions({ ...params, cfg, stateDir: state.stateDir });
      },
    });
    await joinPersistence();
    expect(read(mainKey).mainRestartRecovery?.cycleId).toEqual(expect.any(String));
    expect(read(mainKey).restartRecoveryRuns).toContainEqual({
      runId: `${mainKey}:run`,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    expect(warnings).toContain("restart-reply-drain");
    for (const registration of registrations) {
      expect(registration.controller.signal.reason).toMatchObject({
        code: "OPENCLAW_RESTART_ABORT",
      });
    }
    expect.soft(read(childKey).status).toBe("interrupted");
    expect(hasLiveAgentRunContext(`${childKey}:run`)).toBe(false);
    const active = resolveVisibleActiveSessionRunState({
      context: { chatAbortControllers },
      requestedKey: childKey,
      canonicalKey: childKey,
      sessionId: read(childKey).sessionId,
      agentId: "main",
    });
    expect(active).toEqual({ active: false, runIds: [] });

    rotateAgentEventLifecycleGeneration();
    await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
    const mainTarget = { storePath, sessionKey: mainKey };
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const observed = await commitMainSessionRecovery({
      target: mainTarget,
      command: {
        kind: "observe",
        cycleId: "next-boot",
        lifecycleGeneration,
        sessionKey: mainKey,
      },
    });
    if (
      observed.transition.kind !== "observed" ||
      observed.transition.view.status !== "recoverable"
    ) {
      throw new Error("eligible dashboard main session lost its restart recovery owner");
    }
    const reserved = await commitMainSessionRecovery({
      target: mainTarget,
      command: {
        kind: "prepare_attempt",
        attempt: observed.transition.view.nextAttempt,
        observation: observed.transition.view.observation,
        lifecycleGeneration,
        runId: "resumed-main-run",
        now: Date.now(),
        executionIdentity: { state: "disabled" },
      },
    });
    expect(reserved.transition.kind).toBe("reserved");
    const admitted = await commitMainSessionRecovery({
      target: mainTarget,
      command: {
        kind: "admit_recovery",
        lifecycleGeneration,
        runId: "resumed-main-run",
        sessionId: read(mainKey).sessionId,
        now: Date.now(),
      },
    });
    expect(admitted.transition.kind).toBe("admitted_recovery");
    await persistGatewaySessionLifecycleEvent({
      sessionKey: mainKey,
      event: {
        runId: "resumed-main-run",
        sessionId: read(mainKey).sessionId,
        lifecycleGeneration,
        ts: Date.now(),
        data: { phase: "end" },
      },
    });
    expect(read(mainKey).status).toBe("done");
    const child = read(childKey);
    expect(child).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      endedAt: expect.any(Number),
      lastRunError: expect.stringContaining("restart"),
    });
    expect(child.lifecycleRunId).toBeUndefined();
    expect(child.restartRecoveryRuns).toBeUndefined();
    const row = buildGatewaySessionRow({
      cfg,
      agentId: "main",
      storePath,
      key: childKey,
      store: { [childKey]: child },
      entry: child,
      activeModel: null,
      lightweightListRow: true,
    });
    expect(projectGatewaySessionActiveRun(active, row.status)).toEqual({
      status: "interrupted",
      hasActiveRun: false,
    });
  } finally {
    await unsubscribe();
    await joinPersistence();
    await harness.handler.dispose();
    for (const registration of registrations) {
      registration.cleanup();
    }
    clearAgentRunContext(`${childKey}:run`);
    clearAgentRunContext(`${mainKey}:run`);
  }
});

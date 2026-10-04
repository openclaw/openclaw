import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { commitMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-store.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  clearAgentRunContext,
  claimAgentRunContext,
  hasLiveAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../sessions/session-lifecycle-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "./chat-abort.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
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

it("settles a restart-aborted dashboard child while preserving eligible main-session recovery", async () => {
  const childKey = "agent:main:dashboard:child";
  const mainKey = "agent:main:dashboard:main";
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const persist = vi.fn(persistGatewaySessionLifecycleEvent);
  const harness = createAgentEventTestHarness({
    persistGatewaySessionLifecycleEventForEvent: persist,
  });
  harness.clearAgentRunContext.mockImplementation(clearAgentRunContext);
  const unsubscribe = onAgentEvent(harness.handler);
  const registrations: Array<ReturnType<typeof registerChatAbortController>> = [];
  const joinPersistence = () => Promise.all(persist.mock.results.map((result) => result.value));
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
      expect(read(sessionKey)).toMatchObject({ status: "running", lifecycleRunId: runId });
    }
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
    expect(child).toMatchObject({ status: "interrupted", abortedLastRun: true });
    expect(child.lifecycleRunId).toBeUndefined();
    const row = buildGatewaySessionRow({
      cfg,
      agentId: "main",
      storePath,
      key: childKey,
      store: { [childKey]: child },
      entry: child,
      activeModel: null,
      lightweightListRow: true,
      skipTranscriptUsageFallback: true,
    });
    expect(projectGatewaySessionActiveRun(active, row.status)).toEqual({
      status: "interrupted",
      hasActiveRun: false,
    });
  } finally {
    unsubscribe();
    await joinPersistence();
    harness.handler.dispose();
    for (const registration of registrations) {
      registration.cleanup();
    }
    clearAgentRunContext(`${childKey}:run`);
    clearAgentRunContext(`${mainKey}:run`);
  }
});

it("repairs the prior restart writer's ownerless dashboard child once during startup", async () => {
  const sessionKey = "agent:main:dashboard:legacy-child";
  const target = { storePath, sessionKey };
  // This is the prior writer's restart-only durable shape, including its safe-tools marker.
  await replaceSessionEntry(target, {
    sessionId: "legacy-child",
    spawnDepth: 1,
    status: "running",
    startedAt: 1_000,
    updatedAt: 2_000,
    lifecycleRunId: "legacy-child-run",
    abortedLastRun: true,
    restartRecoveryForceSafeTools: true,
  });
  const unrelatedKey = "agent:main:dashboard:ordinary-child";
  const unrelated: InternalSessionEntry = {
    sessionId: "ordinary-child",
    spawnDepth: 1,
    status: "running",
    startedAt: 1_000,
    updatedAt: 2_000,
  };
  await replaceSessionEntry({ storePath, sessionKey: unrelatedKey }, unrelated);
  const retainedKey = "agent:main:dashboard:retained-child";
  const retained: InternalSessionEntry = {
    ...unrelated,
    sessionId: "retained-child",
    abortedLastRun: true,
    restartRecoveryForceSafeTools: true,
  };
  await replaceSessionEntry({ storePath, sessionKey: retainedKey }, retained);
  const retainedRun = createSubagentRunRecord({
    runId: "retained-child-run",
    childSessionKey: retainedKey,
    requesterSessionKey: "agent:main:dashboard:parent",
    execution: { status: "interrupted", startedAt: 1_000, interruptionReason: "gateway-restart" },
  });
  // Keep only the durable registry owner, as startup sees before registry hydration.
  await mutateSubagentRuns(
    [retainedRun.runId],
    () => ({
      value: undefined,
      postimages: new Map([[retainedRun.runId, retainedRun]]),
    }),
    { runs: new Map() },
  );
  const scan = () => markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
  await scan();
  const settled = loadSessionEntry({ ...target, readConsistency: "latest" });
  expect(settled).toMatchObject({ status: "interrupted", abortedLastRun: true });
  expect(settled?.lifecycleRunId).toBeUndefined();
  await scan();
  expect(loadSessionEntry({ ...target, readConsistency: "latest" })).toEqual(settled);
  expect(
    loadSessionEntry({ storePath, sessionKey: unrelatedKey, readConsistency: "latest" }),
  ).toMatchObject(unrelated);
  expect(
    loadSessionEntry({ storePath, sessionKey: retainedKey, readConsistency: "latest" }),
  ).toMatchObject(retained);
});

it.each([
  { timing: "before scan", owner: "registry" },
  { timing: "before commit", owner: "registry" },
  { timing: "before commit", owner: "admission" },
] as const)(
  "retains a restart-aborted child whose $owner owner appears $timing",
  async ({ timing, owner }) => {
    const sessionKey = "agent:main:dashboard:owned-child";
    const runId = "owned-child-run";
    const entry: InternalSessionEntry = {
      sessionId: "owned-child",
      spawnDepth: 1,
      status: "running",
      startedAt: 1_000,
      updatedAt: 2_000,
      lifecycleRunId: runId,
      abortedLastRun: true,
      restartRecoveryForceSafeTools: true,
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    let claimId: string | undefined;
    let admission: SessionWorkAdmissionLease | undefined;
    const acquire = async () => {
      if (owner === "admission") {
        admission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, entry.sessionId],
          assertAllowed: () => {},
        });
        return;
      }
      claimId = claimAgentRunContext(
        runId,
        { sessionKey, sessionId: entry.sessionId },
        {
          trackOwner: true,
          ownsContext: true,
        },
      );
      expect(claimId).toBeDefined();
    };
    const apply = sessionAccessor.applySessionEntryReplacements;
    const planning = vi.spyOn(sessionAccessor, "applySessionEntryReplacements");
    try {
      if (timing === "before scan") {
        await acquire();
      } else {
        planning.mockImplementationOnce((params) =>
          apply({
            ...params,
            update: async (entries) => {
              const prepared = await params.update(entries);
              await acquire();
              return prepared;
            },
          }),
        );
      }
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
      expect(loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })).toMatchObject(
        entry,
      );
    } finally {
      planning.mockRestore();
      releaseAgentRunContext(runId, claimId);
      clearAgentRunContext(runId);
      admission?.release();
      rotateAgentEventLifecycleGeneration();
    }
  },
);

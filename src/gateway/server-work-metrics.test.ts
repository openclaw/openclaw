import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../agents/subagents/registry/subagent-run-generation.js";
import {
  activateSwarmRun,
  bindSwarmRunReservation,
  holdQueuedSwarmRun,
  releaseSwarmRun,
  reserveSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.operation.js";
import { markReplyOperationExecutionStarted } from "../auto-reply/reply/reply-run-registry.state.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { setDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  onGatewayWorkMetrics,
  type GatewayWorkMetricsSnapshot,
} from "../infra/gateway-work-metrics.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "./chat-queued-turns.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import * as activeRuns from "./server-methods/session-active-runs.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { startGatewayWorkMetrics } from "./server-work-metrics.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetAgentEventsForTest();
});

it("bounds live projection over idle history through admission, progress, drain, and disposal", async (test) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = { agents: { entries: { main: {} } } };
    const context = requestContext(config);
    context.chatQueuedTurns = new Map();
    const names = ["chat", "reply", ...Array.from({ length: 512 }, (_, i) => `idle-${i}`)];
    const sessionKeys = names.map((name) => `agent:main:${name}`);
    await applySessionEntryCanonicalReplacements({
      agentId: "main",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
      sessionKeys,
      skipMaintenance: true,
      update: () => ({
        replacements: names.map((name) => ({
          sessionKey: `agent:main:${name}`,
          previousSessionKeys: [],
          entry: { sessionId: name, updatedAt: 1, visibility: "shared" as const },
        })),
        result: undefined,
      }),
    });
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    expect(projection.selectEntries({ sortBy: null }, true)).toHaveLength(514);
    const prepareOriginal = projection.prepareSelection.bind(projection);
    const prepare = vi.spyOn(projection, "prepareSelection");
    const inspectors = createGatewayServerActiveWorkInspectors({ ...context, cron: {} });
    const inspectedKeys = new Set<string>();
    const createProjector = activeRuns.createVisibleActiveSessionRunProjector;
    vi.spyOn(activeRuns, "createVisibleActiveSessionRunProjector").mockImplementation((...args) => {
      const project = createProjector(...args);
      return Object.assign(
        (params: Parameters<typeof project>[0]) => {
          inspectedKeys.add(params.canonicalKey);
          return project(params);
        },
        { candidateSessionIdsOrKeys: project.candidateSessionIdsOrKeys },
      );
    });
    const client = sharingPolicyClient({ scopes: ["operator.admin"] });
    setDiagnosticsEnabledForProcess(true);
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const source = startGatewayWorkMetrics({
      context,
      inspectors,
      log: createSubsystemLogger("gateway/work-metrics-test"),
    });
    const chat = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: "chat-run",
      sessionId: "chat",
      sessionKey: "agent:main:chat",
      agentId: "main",
      timeoutMs: 60_000,
    });
    const reply = createReplyOperation({
      sessionKey: "agent:main:reply",
      sessionId: "reply",
      agentId: "main",
      resetTriggered: false,
    });
    const queued = new AbortController();
    registerQueuedChatTurn({
      chatQueuedTurns: context.chatQueuedTurns,
      runId: "queued-turn",
      controller: queued,
      sessionId: "reply",
      sessionKey: "agent:main:reply",
      agentId: "main",
    });
    let claim = claimAgentRunContext(
      "agent-run",
      {
        agentId: "main",
        sessionKey: "agent:main:reply",
        sessionId: "reply",
        projectSessionActive: true,
      },
      { trackOwner: true, ownsContext: true },
    );
    const releaseWait = registerAgentRunCapacityWait("agent-run", getAgentRunLifecycleGeneration());
    await vi.runOnlyPendingTimersAsync();
    expect(prepare).not.toHaveBeenCalled();
    let latest: GatewayWorkMetricsSnapshot | undefined;
    let next = createDeferredCore<GatewayWorkMetricsSnapshot>();
    const unsubscribe = onGatewayWorkMetrics((snapshot) => {
      latest = snapshot;
      if (snapshot) {
        next.resolve(snapshot);
      }
    });
    const read = async (expected: GatewayWorkMetricsSnapshot) => {
      inspectedKeys.clear();
      await vi.runOnlyPendingTimersAsync();
      const snapshot = await withinTest(next.promise, test.signal);
      next = createDeferredCore<GatewayWorkMetricsSnapshot>();
      expect(snapshot.sessions.running).toBe(expected.sessions.running);
      expect(snapshot.sessions.queued).toBe(expected.sessions.queued);
      expect(snapshot.work).toEqual(expected.work);
      expect(inspectedKeys.size).toBe(expected.sessions.running + expected.sessions.queued);
      const list = await listSessions({
        client,
        context,
        request: { activeOnly: true, includeGlobal: true, includeUnknown: true, limit: 100 },
      });
      expect(snapshot.sessions).toEqual({
        running: list.sessions.filter((row) => row.status !== "queued").length,
        queued: list.sessions.filter((row) => row.status === "queued").length,
      });
      const { agentRuns, chatRuns, queuedTurns } =
        createGatewayActiveWorkSnapshot(inspectors).counts;
      expect(snapshot.work).toEqual({ agentRuns, chatRuns, queuedTurns });
    };
    try {
      setDiagnosticsEnabledForProcess(false);
      notifyGatewayWorkMetricsChanged();
      await vi.runOnlyPendingTimersAsync();
      expect(prepare).not.toHaveBeenCalled();
      expect(latest).toBeUndefined();
      setDiagnosticsEnabledForProcess(true);
      notifyGatewayWorkMetricsChanged();
      await read({
        sessions: { running: 1, queued: 1 },
        work: { agentRuns: 1, chatRuns: 1, queuedTurns: 1 },
      });
      releaseWait?.();
      markReplyOperationExecutionStarted(reply);
      await read({
        sessions: { running: 2, queued: 0 },
        work: { agentRuns: 1, chatRuns: 1, queuedTurns: 1 },
      });
      retireQueuedChatTurnCancellation(context.chatQueuedTurns, "queued-turn", queued);
      queued.abort();
      await read({
        sessions: { running: 2, queued: 0 },
        work: { agentRuns: 1, chatRuns: 1, queuedTurns: 0 },
      });
      reply.complete();
      chat.cleanup();
      releaseAgentRunContext("agent-run", claim!);
      claim = undefined;
      await read({
        sessions: { running: 0, queued: 0 },
        work: { agentRuns: 0, chatRuns: 0, queuedTurns: 0 },
      });

      const swarm = {
        runId: "swarm-run",
        childSessionKey: "agent:main:reply",
        requesterSessionKey: "agent:main:chat",
        requesterDisplayKey: "chat",
        collect: true,
        groupId: "metrics-group",
        task: "Synthetic queued work",
        cleanup: "keep",
        createdAt: 1,
        execution: { status: "queued" },
      } satisfies SubagentRunRecord;
      subagentRuns.set(swarm.runId, swarm);
      expect(
        reserveSwarmRun({
          groupId: swarm.groupId,
          runId: swarm.runId,
          maxConcurrent: 1,
          activeRunIds: ["occupied-slot"],
        }),
      ).toBe(true);
      const changes = vi.fn();
      const stopChanges = sessionChanges.subscribe(changes);
      const removal = createDeferredCore();
      const launch = vi.fn(async () => {});
      let hold: ReturnType<typeof holdQueuedSwarmRun>;
      try {
        bindSwarmRunReservation(swarm.runId, getSubagentRunRuntimeKey(swarm));
        await read({
          sessions: { running: 1, queued: 0 },
          work: { agentRuns: 0, chatRuns: 0, queuedTurns: 0 },
        });
        activateSwarmRun({
          groupId: swarm.groupId,
          runId: swarm.runId,
          start: launch,
          onStartFailure: () => true,
          onRemoved: () => removal.promise,
        });
        await read({
          sessions: { running: 0, queued: 1 },
          work: { agentRuns: 0, chatRuns: 0, queuedTurns: 0 },
        });
        hold = holdQueuedSwarmRun(swarm.runId);
        await read({
          sessions: { running: 1, queued: 0 },
          work: { agentRuns: 0, chatRuns: 0, queuedTurns: 0 },
        });
        expect(hold?.withdraw()).toBe(true);
        await read({
          sessions: { running: 0, queued: 0 },
          work: { agentRuns: 0, chatRuns: 0, queuedTurns: 0 },
        });
        expect(launch).not.toHaveBeenCalled();
        expect(changes).not.toHaveBeenCalled();
      } finally {
        stopChanges();
        removal.resolve();
        hold ??= holdQueuedSwarmRun(swarm.runId);
        hold?.withdraw();
        await hold?.release();
        releaseSwarmRun("occupied-slot");
        subagentRuns.delete(swarm.runId);
      }

      const held = createDeferredCore();
      prepare.mockImplementationOnce(async (...args) => {
        await held.promise;
        await prepareOriginal(...args);
      });
      completeQueuedChatTurn(context.chatQueuedTurns, "queued-turn", queued);
      await vi.runOnlyPendingTimersAsync();
      const stopping = source.stop();
      expect(latest).toBeUndefined();
      held.resolve();
      await stopping;
      expect(latest).toBeUndefined();
    } finally {
      unsubscribe();
      await source.stop();
      chat.cleanup();
      reply.complete();
      completeQueuedChatTurn(context.chatQueuedTurns, "queued-turn", queued);
      releaseWait?.();
      if (claim) {
        releaseAgentRunContext("agent-run", claim);
      }
    }
  });
});

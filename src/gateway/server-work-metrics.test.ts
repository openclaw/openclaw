import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../agents/subagents/registry/subagent-run-generation.js";
import * as swarmScheduler from "../agents/subagents/swarm/swarm-scheduler.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import * as runRegistry from "../infra/agent-run-registry.js";
import { setDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  onGatewayWorkMetrics,
  type GatewayWorkMetricsSnapshot,
} from "../infra/gateway-work-metrics.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.js";
import {
  registerRpcSource,
  requestRpcSourceCancellation,
} from "../sessions/session-controller.rpc-sources.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import { registerRpcSourceForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import * as activeRuns from "./server-methods/session-active-runs.js";
import * as sessionReads from "./server-methods/sessions-read-cache.test-support.js";
import { startGatewayWorkMetrics } from "./server-work-metrics.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "./test-helpers.rpc-source.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetAgentEventsForTest();
});

it("bounds live projection over idle history through admission, progress, drain, and disposal", async (test) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = sessionReads.requestContext({ agents: { entries: { main: {} } } });
    const session = (sessionId: string) => ({
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
    });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const names = ["chat", "reply", ...Array.from({ length: 512 }, (_, i) => `idle-${i}`)];
    const sessionKeys = names.map((name) => `agent:main:${name}`);
    await applySessionEntryCanonicalReplacements({
      agentId: "main",
      storePath,
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
    await sessionReads.initializeSessionReadContext(context);
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
    const chat = registerRpcSourceForTest({
      storeScope: storePath,
      runId: "chat-run",
      ...session("chat"),
    });
    chat.initializeTiming();
    const releaseChat = await claimRpcSourceForTest(chat.entry);
    chat.markExecutionStarted();
    const replySource = createRpcSourceForTest(
      {},
      {
        storeScope: storePath,
        ...session("reply"),
      },
    );
    const releaseReply = await claimRpcSourceForTest(replySource, { executionStarted: false });
    const reply = expectDefined(replySource.input.claim?.operation, "admitted reply turn");
    const queued = createRpcSourceForTest(
      {},
      {
        storeScope: storePath,
        runId: "queued-turn",
        ...session("reply"),
        phase: "waiting",
      },
    );
    registerRpcSource("queued-turn", queued);
    let claim = runRegistry.claimAgentRunContext(
      "agent-run",
      { ...session("reply"), projectSessionActive: true },
      { trackOwner: true, ownsContext: true },
    );
    const releaseWait = registerAgentRunCapacityWait(
      "agent-run",
      runRegistry.getAgentRunLifecycleGeneration(),
    );
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
    const read = async (
      running: number,
      queuedSessions: number,
      work = { agentRuns: 0, chatRuns: 0, queuedTurns: 0 },
    ) => {
      inspectedKeys.clear();
      await vi.runOnlyPendingTimersAsync();
      const snapshot = await withinTest(next.promise, test.signal);
      next = createDeferredCore<GatewayWorkMetricsSnapshot>();
      expect(snapshot).toEqual({ sessions: { running, queued: queuedSessions }, work });
      expect(inspectedKeys.size).toBe(running + queuedSessions);
      const list = await sessionReads.listSessions({
        client,
        context,
        request: { activeOnly: true, includeGlobal: true, includeUnknown: true, limit: 100 },
      });
      expect(snapshot.sessions).toEqual({
        running: list.sessions.filter((row) => row.status !== "queued").length,
        queued: list.sessions.filter((row) => row.status === "queued").length,
      });
      expect(createGatewayActiveWorkSnapshot(inspectors).counts).toMatchObject(snapshot.work);
    };
    try {
      setDiagnosticsEnabledForProcess(false);
      notifyGatewayWorkMetricsChanged();
      await vi.runOnlyPendingTimersAsync();
      expect(prepare).not.toHaveBeenCalled();
      expect(latest).toBeUndefined();
      setDiagnosticsEnabledForProcess(true);
      notifyGatewayWorkMetricsChanged();
      const liveWork = { agentRuns: 1, chatRuns: 1, queuedTurns: 1 };
      await read(1, 1, liveWork);
      releaseWait?.();
      markReplyOperationExecutionStarted(reply);
      await read(2, 0, liveWork);
      requestRpcSourceCancellation(queued, new Error("queued turn stopped"));
      await queued.input.settlement.promise;
      await read(2, 0, { ...liveWork, queuedTurns: 0 });
      releaseReply();
      await replySource.input.settlement.promise;
      releaseChat();
      chat.cleanup();
      await chat.entry.input.settlement.promise;
      runRegistry.releaseAgentRunContext("agent-run", claim!);
      claim = undefined;
      await read(0, 0);

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
        swarmScheduler.reserveSwarmRun({
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
      let hold: ReturnType<typeof swarmScheduler.holdQueuedSwarmRun>;
      try {
        swarmScheduler.bindSwarmRunReservation(swarm.runId, getSubagentRunRuntimeKey(swarm));
        await read(1, 0);
        swarmScheduler.activateSwarmRun({
          groupId: swarm.groupId,
          runId: swarm.runId,
          start: launch,
          onStartFailure: () => true,
          onRemoved: () => removal.promise,
        });
        await read(0, 1);
        hold = swarmScheduler.holdQueuedSwarmRun(swarm.runId);
        await read(1, 0);
        expect(hold?.withdraw()).toBe(true);
        await read(0, 0);
        expect(launch).not.toHaveBeenCalled();
        expect(changes).not.toHaveBeenCalled();
      } finally {
        stopChanges();
        removal.resolve();
        hold ??= swarmScheduler.holdQueuedSwarmRun(swarm.runId);
        hold?.withdraw();
        await hold?.release();
        swarmScheduler.releaseSwarmRun("occupied-slot");
        subagentRuns.delete(swarm.runId);
      }

      const held = createDeferredCore();
      prepare.mockImplementationOnce(async (...args) => {
        await held.promise;
        await prepareOriginal(...args);
      });
      try {
        notifyGatewayWorkMetricsChanged();
        await vi.runOnlyPendingTimersAsync();
        const stopping = source.stop();
        expect(latest).toBeUndefined();
        held.resolve();
        await stopping;
        expect(latest).toBeUndefined();
      } finally {
        held.resolve();
      }
    } finally {
      unsubscribe();
      await source.stop();
      releaseChat();
      chat.cleanup();
      releaseReply();
      await replySource.input.settlement.promise;
      requestRpcSourceCancellation(queued, new Error("test cleanup"));
      await Promise.allSettled([
        chat.entry.input.settlement.promise,
        queued.input.settlement.promise,
      ]);
      releaseWait?.();
      if (claim) {
        runRegistry.releaseAgentRunContext("agent-run", claim);
      }
    }
  });
});

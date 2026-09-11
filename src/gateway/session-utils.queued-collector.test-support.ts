import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createInitialSubagentSession } from "../agents/subagents/spawn/subagent-spawn-session-patch.js";
import { spawnSubagentDirect } from "../agents/subagents/spawn/subagent-spawn.js";
import { testing as spawnTesting } from "../agents/subagents/spawn/subagent-spawn.test-support.js";
import { reserveSwarmRun } from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionResetPolicy } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { getTaskFlowByIdForOwner } from "../tasks/task-flow-owner-access.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { findTaskByRunIdForStatus } from "../tasks/task-status-access.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import { buildAgentSessionPatch } from "./server-methods/agent-session-patch.js";
import { createChatAbortContext } from "./server-methods/chat.abort.test-helpers.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import type { SessionsListResult } from "./session-utils.types.js";

export function useQueuedCollectorFixture() {
  const parentKey = "agent:main:dashboard:queued-projection";
  let state: OpenClawTestState;
  let stopLifecycleListener: (() => void) | undefined;
  const launchedRunIds: string[] = [];
  let successorSequence = 0;

  beforeEach(async () => {
    resetGatewayWorkAdmission();
    schedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    resetAgentEventsForTest({ preserveListeners: true });
    state = await createOpenClawTestState({ label: "queued-collector-projection" });
    state.applyEnv();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    successorSequence = 0;
    await state.writeConfig({
      session: { mainKey: "main", scope: "per-sender" },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: {
        defaults: { workspace: state.workspaceDir },
        entries: { main: { workspace: state.workspaceDir } },
      },
    });
    registryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      // These collectors own no browser sessions; lifecycle cleanup has separate coverage.
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      callGateway: async () => await new Promise<never>(() => {}),
      restoreSubagentRunsFromDisk: () => 0,
    });
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        expect(method).toBe("agent");
        const runId = String(params.idempotencyKey);
        const sessionKey = String(params.sessionKey);
        const { storePath, entry } = loadGatewaySessionEntryReadOnly(sessionKey);
        await upsertSessionEntryCore(
          { storePath, sessionKey },
          buildAgentSessionPatch({
            freshEntry: entry,
            initialEntry: entry,
            cfg: getRuntimeConfig(),
            sessionAgentId: "main",
            canonicalSessionKey: sessionKey,
            storePath,
            requestLabel: typeof params.label === "string" ? params.label : undefined,
            normalizedSpawned: {},
            requestDeliveryHint: undefined,
            expectedExistingSessionId: entry?.sessionId,
            hasRestoredCronContinuation: false,
            resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
            now: Date.now(),
            isSystemGatewayRun: true,
            visibleRequest: false,
            fallbackSessionId: expectDefined(entry?.sessionId, "created child identity"),
            touchInteraction: false,
            failedSessionTranscriptMissing: () => false,
          }).patch,
        );
        launchedRunIds.push(runId);
        registerAgentRunContext(runId, { sessionKey, projectSessionActive: true });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: Date.now() },
        });
        return { runId, status: "accepted" } as T;
      },
    });
  });

  afterEach(async () => {
    stopLifecycleListener?.();
    stopLifecycleListener = undefined;
    flushPendingSessionsChangedEvents();
    schedulerTesting.reset();
    for (const runId of launchedRunIds.splice(0)) {
      clearAgentRunContext(runId);
    }
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    registryTesting.setDepsForTest();
    spawnTesting.setDepsForTest();
    resetAgentEventsForTest({ preserveListeners: true });
    resetGatewayWorkAdmission();
    await state.cleanup();
  });

  function requestContext() {
    const context = createChatAbortContext({
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
      addChatRun: vi.fn(),
      logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSessionEventSubscriberConnIds: () => new Set(["observer"]),
      broadcastToConnIds: vi.fn(),
    }) as unknown as GatewayRequestContext;
    registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: "parent-turn",
      sessionId: "parent-session",
      sessionKey: parentKey,
      agentId: "main",
      ownerConnId: "parent-requester",
      timeoutMs: 60_000,
    });
    return context;
  }

  function operatorClient(
    connId = "parent-requester",
    admin = false,
  ): GatewayRequestHandlerOptions["client"] {
    return {
      connId,
      connect: { role: "operator", scopes: [admin ? "operator.admin" : "operator.write"] },
    } as GatewayRequestHandlerOptions["client"];
  }

  async function listChildren(context: GatewayRequestContext): Promise<SessionsListResult> {
    const respond = vi.fn();
    await expectDefined(
      sessionReadHandlers["sessions.list"],
      "sessions.list handler",
    )({
      req: { type: "req", id: "queued-list", method: "sessions.list" },
      params: {
        agentId: "main",
        spawnedBy: parentKey,
        limit: 10,
        includeDerivedTitles: false,
        includeLastMessage: false,
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    return respond.mock.calls[0]![1] as SessionsListResult;
  }

  async function spawnCollectors(
    labels = ["Collector A", "Collector B"],
    completionOwnerKey?: string,
  ) {
    const results = await Promise.all(
      labels.map((label) =>
        spawnSubagentDirect(
          {
            task: "Wait for cancellation",
            label,
            collect: true,
            context: "isolated",
            lightContext: true,
          },
          {
            agentSessionKey: parentKey,
            completionOwnerKey,
            requesterRunId: "parent-turn",
            requesterTurnRunId: "parent-turn",
          },
        ),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(labels.map(() => "accepted"));
    await vi.waitFor(() => expect(launchedRunIds).toEqual([results[0]?.runId]));
    return results;
  }

  async function createQueuedReservation(name = "reserved") {
    const childSessionKey = `agent:main:subagent:${name}`;
    const runId = `${name}-collector`;
    const groupId = `swarm:${parentKey}:parent-turn`;
    reserveSwarmRun({ runId, groupId, maxConcurrent: 1, activeRunIds: [] });
    expect(
      await createInitialSubagentSession({
        cfg: getRuntimeConfig(),
        targetAgentId: "main",
        childSessionKey,
        label: "Reserved collector",
        incognito: false,
        requesterInternalKey: parentKey,
        completionOwnerSessionKey: parentKey,
        creationPolicy: { actor: { type: "agent", id: "main" } },
        modelPatch: {},
        swarmGroupId: groupId,
        collect: true,
      }),
    ).toMatchObject({ status: "ok" });
    const registration = {
      runId,
      childSessionKey,
      requesterSessionKey: parentKey,
      requesterTurnRunId: "parent-turn",
      requesterDisplayKey: parentKey,
      task: "Wait for a slot",
      cleanup: "keep" as const,
      collect: true,
      queued: true,
      groupId,
      taskRowOwnership: "required" as const,
    };
    registerSubagentRun(registration);
    return {
      entry: expectDefined(subagentRuns.get(runId), "registered reservation"),
    };
  }

  function registerQueuedSuccessor(
    previous: SubagentRunRecord,
    options: { reserve?: boolean } = {},
  ) {
    const groupId = expectDefined(previous.groupId, "queued collector group");
    const runId = `${previous.runId}-successor-${++successorSequence}`;
    if (options.reserve) {
      reserveSwarmRun({ runId, groupId, maxConcurrent: 1, activeRunIds: [] });
    }
    const receipt = expectDefined(
      registerSubagentRun({
        runId,
        childSessionKey: previous.childSessionKey,
        requesterSessionKey: previous.requesterSessionKey,
        requesterTurnRunId: previous.requesterTurnRunId,
        requesterDisplayKey: previous.requesterDisplayKey,
        task: previous.task,
        cleanup: previous.cleanup,
        collect: true,
        queued: true,
        groupId,
        taskRowOwnership: "required",
      }),
      "queued successor registration receipt",
    );
    const entry = expectDefined(subagentRuns.get(runId), "queued successor");
    expect(entry).toMatchObject({
      runId,
      childSessionKey: previous.childSessionKey,
      taskRunId: runId,
      generation: (previous.generation ?? 0) + 1,
      taskOwnershipPolicy: "core_required",
    });
    const task = expectDefined(findTaskByRunIdForStatus(runId), "queued successor task");
    expect(task).toMatchObject({
      runId,
      childSessionKey: previous.childSessionKey,
      detail: { generation: entry.generation },
    });
    expect(
      getTaskFlowByIdForOwner({
        flowId: expectDefined(task.parentFlowId, "queued successor mirrored flow"),
        callerOwnerKey: previous.requesterSessionKey,
      }),
    ).toMatchObject({
      ownerKey: previous.requesterSessionKey,
      syncMode: "task_mirrored",
    });
    return { entry, receipt };
  }

  function observeLifecycle(listener: Parameters<typeof onSessionLifecycleEvent>[0]) {
    stopLifecycleListener = onSessionLifecycleEvent(listener);
  }

  return {
    parentKey,
    launchedRunIds,
    requestContext,
    operatorClient,
    listChildren,
    spawnCollectors,
    createQueuedReservation,
    registerQueuedSuccessor,
    observeLifecycle,
  };
}

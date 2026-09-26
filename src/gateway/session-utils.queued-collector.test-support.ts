import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createInitialSubagentSession } from "../agents/subagents/spawn/subagent-spawn-session-patch.js";
import { spawnSubagentDirect } from "../agents/subagents/spawn/subagent-spawn.js";
import { testing as spawnTesting } from "../agents/subagents/spawn/subagent-spawn.test-support.js";
import { closeSwarmScheduler, reserveSwarmRun } from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionResetPolicy } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
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
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import * as sessionStoreWorker from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import type { SessionsListResult } from "./session-utils.types.js";

vi.mock("./server-recovery-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-recovery-runtime-context.js")>()),
  bindGatewayLifecycleRequest: () => async () => await new Promise<never>(() => {}),
}));
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));
vi.mock("../agents/runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
  return { loadAgentRuntimePluginRegistryHandle: createEmptyPluginRegistry };
});
vi.mock("../agents/subagents/registry/subagent-registry-state.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/subagents/registry/subagent-registry-state.js")
  >()),
  restoreSubagentRunsFromDisk: () => 0,
}));

export function useQueuedCollectorFixture() {
  const parentKey = "agent:main:dashboard:queued-projection";
  let state: OpenClawTestState;
  let projection: SessionRowProjection;
  const launchedRunIds: string[] = [];

  beforeEach(async () => {
    resetGatewayWorkAdmission();
    schedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    resetAgentEventsForTest({ preserveListeners: true });
    state = await createOpenClawTestState({ label: "queued-collector-projection" });
    state.applyEnv();
    await state.writeConfig({
      session: { mainKey: "main", scope: "per-sender" },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: {
        defaults: { workspace: state.workspaceDir },
        entries: { main: { workspace: state.workspaceDir } },
      },
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
    projection = await createSessionRowProjection({
      cfg: getRuntimeConfig(),
      getConfig: getRuntimeConfig,
    });
  });

  afterEach(async () => {
    // Keep dispatch dependencies and session state alive until owned launch cleanup settles.
    await closeSwarmScheduler();
    await flushPendingSessionsChangedEvents();
    schedulerTesting.reset();
    for (const runId of launchedRunIds.splice(0)) {
      clearAgentRunContext(runId);
    }
    resetSubagentRegistryForTests({ persist: false });
    spawnTesting.setDepsForTest();
    resetAgentEventsForTest({ preserveListeners: true });
    resetGatewayWorkAdmission();
    projection.dispose();
    await state.cleanup();
  });

  function requestContext() {
    const context = createChatAbortContext({
      getRuntimeConfig,
      ...bindSessionRowProjection({}, () => projection),
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
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[2]).toBeUndefined();
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

  async function createQueuedReservation(
    name = "reserved",
    creationPolicy: Parameters<typeof createInitialSubagentSession>[0]["creationPolicy"] = {
      actor: { type: "agent", id: "main" },
    },
  ) {
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
        creationPolicy,
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
    };
    await registerSubagentRun(registration);
    return {
      registration,
      entry: expectDefined(subagentRuns.get(runId), "registered reservation"),
    };
  }

  async function spawnCollectorsWithDelayedFirstRead() {
    const resolveTarget = sessionStoreWorker.resolveGatewaySessionStoreTargetInWorker;
    const requester = await resolveTarget({ cfg: getRuntimeConfig(), key: parentKey });
    let firstReadStarted = false;
    const read = vi
      .spyOn(sessionStoreWorker, "resolveGatewaySessionStoreTargetInWorker")
      .mockImplementation(async (params) => {
        if (params.key !== parentKey) {
          return await resolveTarget(params);
        }
        if (!firstReadStarted) {
          firstReadStarted = true;
          await Promise.resolve();
        }
        return requester;
      });
    try {
      return await spawnCollectors();
    } finally {
      read.mockRestore();
    }
  }

  return {
    parentKey,
    launchedRunIds,
    requestContext,
    operatorClient,
    listChildren,
    spawnCollectors,
    spawnCollectorsWithDelayedFirstRead,
    createQueuedReservation,
  };
}

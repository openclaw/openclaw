import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as registry from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SpawnSubagentContext } from "../agents/subagents/spawn/subagent-spawn-contract.js";
import { createInitialSubagentSession } from "../agents/subagents/spawn/subagent-spawn-session-patch.js";
import { spawnSubagentDirect } from "../agents/subagents/spawn/subagent-spawn.js";
import { testing as spawnTesting } from "../agents/subagents/spawn/subagent-spawn.test-support.js";
import { closeSwarmScheduler, reserveSwarmRun } from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../config/config.js";
import { resolveSessionResetPolicy } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "./chat-abort.js";
import { buildAgentSessionPatch } from "./server-methods/agent-session-patch.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createChatAbortContext } from "./server-methods/chat.abort.test-helpers.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type {
  GatewayRequestContext as Context,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";
import type { SessionsListResult } from "./session-utils.types.js";

type Client = GatewayRequestHandlerOptions["client"];
type RpcParams = Record<string, unknown>;

vi.mock(import("./server-recovery-runtime-context.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  bindGatewayLifecycleRequest: () => async () => await new Promise<never>(() => {}),
}));
vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));
vi.mock("../agents/runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
  return { loadAgentRuntimePluginRegistryHandle: createEmptyPluginRegistry };
});
vi.mock(
  import("../agents/subagents/registry/subagent-registry-persistence.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    restoreSubagentRunsFromDisk: async () => 0,
  }),
);

export function useQueuedCollectorFixture() {
  const parentKey = "agent:main:dashboard:queued-projection";
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let projection: SessionRowProjection;
  const launchedRunIds: string[] = [];
  const launchSignals = new Map<string, ReturnType<typeof createDeferred<void>>>();

  function waitForLaunch(runId: string) {
    if (launchedRunIds.includes(runId)) {
      return Promise.resolve();
    }
    const signal = launchSignals.get(runId) ?? createDeferred();
    launchSignals.set(runId, signal);
    return signal.promise;
  }

  beforeEach(async () => {
    resetGatewayWorkAdmission();
    schedulerTesting.reset();
    await registry.resetSubagentRegistryForTests({ persist: false });
    resetAgentEventsForTest({ preserveListeners: true });
    state = await createOpenClawTestState({ label: "queued-collector-projection" });
    await state.writeConfig({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    });
    await captureRuntimeConfigAsyncReader()();
    await loadOrCreateProcessDeviceIdentityAsync();
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(method: string, params: RpcParams) => {
        expect(method).toBe("agent");
        const runId = String(params.idempotencyKey);
        const sessionKey = String(params.sessionKey);
        const { storePath, entry } = await loadGatewaySessionEntryReadOnlyAsync(sessionKey);
        const { patch } = await buildAgentSessionPatch({
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
        });
        await upsertSessionEntryCore({ storePath, sessionKey }, patch);
        launchedRunIds.push(runId);
        registerAgentRunContext(runId, { sessionKey, projectSessionActive: true });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: Date.now() },
        });
        launchSignals.get(runId)?.resolve();
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
    launchedRunIds.splice(0).forEach((runId) => clearAgentRunContext(runId));
    launchSignals.clear();
    await registry.resetSubagentRegistryForTests({ persist: false });
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
    }) as unknown as Context;
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

  function operatorClient(connId = "parent-requester", admin = false): Client {
    return {
      connId,
      connect: { role: "operator", scopes: [admin ? "operator.admin" : "operator.write"] },
    } as Client;
  }

  function requestOptions(context: Context, method: string, params: RpcParams) {
    return {
      req: { type: "req" as const, id: method, method },
      params,
      context,
      client: operatorClient(),
      isWebchatConnect: () => false,
      respond: vi.fn(),
    };
  }

  async function listChildren(context: Context): Promise<SessionsListResult> {
    const options = requestOptions(context, "sessions.list", {
      agentId: "main",
      spawnedBy: parentKey,
    });
    options.client = null;
    await sessionReadHandlers["sessions.list"]!(options);
    expect(options.respond).toHaveBeenCalledOnce();
    expect(options.respond.mock.calls[0]?.[0]).toBe(true);
    expect(options.respond.mock.calls[0]?.[2]).toBeUndefined();
    return options.respond.mock.calls[0]![1] as SessionsListResult;
  }

  function spawnCollector(label: string, context: Partial<SpawnSubagentContext> = {}) {
    return spawnSubagentDirect(
      {
        task: "Wait for cancellation",
        label,
        collect: true,
        context: "isolated",
        lightContext: true,
      },
      {
        agentSessionKey: parentKey,
        requesterRunId: "parent-turn",
        requesterTurnRunId: "parent-turn",
        ...context,
      },
    );
  }

  async function spawnCollectors(
    labels = ["Collector A", "Collector B"],
    completionOwnerKey?: string,
  ) {
    const results: Awaited<ReturnType<typeof spawnSubagentDirect>>[] = [];
    for (const label of labels) {
      const result = await spawnCollector(label, { completionOwnerKey });
      expect(result.status).toBe("accepted");
      results.push(result);
      if (results.length === 1) {
        await waitForLaunch(expectDefined(result.runId, "first collector run"));
      }
    }
    expect(launchedRunIds).toEqual([results[0]?.runId]);
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
    const created = await createInitialSubagentSession({
      cfg: getRuntimeConfig(),
      requesterAgentId: "main",
      targetAgentId: "main",
      childSessionKey,
      incognito: false,
      requesterInternalKey: parentKey,
      parentTarget: await resolveGatewaySessionStoreTargetInWorker({
        cfg: getRuntimeConfig(),
        key: parentKey,
        agentId: "main",
        projection: "full",
      }),
      completionOwnerSessionKey: parentKey,
      creationPolicy,
      modelPatch: {},
      swarmGroupId: groupId,
      collect: true,
    });
    if (created.status !== "ok") {
      throw new Error(created.error);
    }
    const registration = {
      runId,
      childSessionKey,
      childAgentId: "main",
      sessionEntry: expectDefined(created.entry, "created reservation identity"),
      requesterSessionKey: parentKey,
      requesterTurnRunId: "parent-turn",
      requesterDisplayKey: parentKey,
      task: "Wait for a slot",
      cleanup: "keep" as const,
      collect: true,
      queued: true,
      groupId,
    };
    await registry.registerSubagentRun(registration);
    return {
      registration,
      entry: expectDefined(subagentRuns.get(runId), "registered reservation"),
    };
  }

  async function expectUnstartedChildHistory(
    context: Context,
    sessionKey: string,
    activeRunIds: string[],
  ) {
    const options = requestOptions(context, "chat.history", {
      sessionKey,
      agentId: "main",
      offset: 0,
    });
    await chatHistoryHandlers["chat.history"]!(options);
    const { respond } = options;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        messages: [],
        hasMore: false,
        totalMessages: 0,
        sessionInfo: expect.objectContaining({
          hasActiveRun: activeRunIds.length > 0,
          activeRunIds,
          status: activeRunIds.length > 0 ? "queued" : "killed",
        }),
      }),
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("inFlightRun");
    expect(respond.mock.calls[0]?.[1]?.sessionInfo.startedAt).toBeUndefined();
    expect(respond.mock.calls[0]?.[1]?.sessionInfo.runtimeMs).toBeUndefined();
  }

  return {
    parentKey,
    launchedRunIds,
    waitForLaunch,
    requestContext,
    operatorClient,
    requestOptions,
    listChildren,
    spawnCollectors,
    spawnCollector,
    createQueuedReservation,
    expectUnstartedChildHistory,
  };
}

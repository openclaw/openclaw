import { vi } from "vitest";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import type { AgentTurnContext } from "./types.js";

function createContext(): AgentTurnContext {
  return {
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    deps: {},
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () => new Set(),
    loadGatewayModelCatalog: vi.fn(async () => []),
    loadGatewayModelCatalogSnapshot: vi.fn<AgentTurnContext["loadGatewayModelCatalogSnapshot"]>(),
    nodeSendToSession: vi.fn(),
    logGateway: {
      subsystem: "gateway-dispatch-test",
      isEnabled: () => false,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      child: vi.fn<AgentTurnContext["logGateway"]["child"]>(),
    },
  };
}

export function createTrackedDispatch() {
  const runId = "deferred-task-run";
  const sessionKey = "agent:main:dispatch-owner";
  const context = createContext();
  const entry: ChatAbortControllerEntry = {
    controller: new AbortController(),
    sessionId: "dispatch-session",
    sessionKey,
    lifecycleGeneration: "dispatch-generation",
    operationalRunInstance: { runId, instanceId: "original-instance" },
    startedAtMs: 1,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  context.chatAbortControllers.set(runId, entry);
  const task: TaskRecord = {
    taskId: "created-task",
    runtime: "cli",
    runId,
    sourceId: runId,
    ownerKey: sessionKey,
    requesterSessionKey: sessionKey,
    childSessionKey: sessionKey,
    scopeKind: "session",
    task: "run only for the admitted owner",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1,
    startedAt: 1,
  };
  return { runId, sessionKey, context, entry, task };
}

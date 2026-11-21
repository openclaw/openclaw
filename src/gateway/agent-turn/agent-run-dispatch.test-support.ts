import { vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createChatRunState } from "../server-chat-state.js";
import { createTestRpcSource } from "./rpc-source.test-support.js";
import type { AgentTurnContext } from "./types.js";

export function createAgentTurnTestContext(): AgentTurnContext {
  return {
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    deps: {},
    getRuntimeConfig: () => ({}),
    trackExecution: async (work) => await work(),
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
  const runId = "dispatch-run";
  const sessionKey = "agent:main:dispatch-owner";
  const context = createAgentTurnTestContext();
  const entry = createTestRpcSource(
    {
      sessionId: "dispatch-session",
      sessionKey,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      operationalRunInstance: { runId, instanceId: "original-instance" },
    },
    runId,
  );
  rpcSourceTesting.set(runId, entry);
  return { runId, sessionKey, context, entry };
}

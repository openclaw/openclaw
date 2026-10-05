import { vi } from "vitest";
import {
  emitAgentEvent,
  emitAgentEvents,
  registerChatRun,
  registerNamedChatRun,
} from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  type AgentEventHandlerOptions,
} from "./server-chat.js";

export type AgentEventTestHarnessOptions = {
  now?: number;
  resolveSessionKeyForRun?: (runId: string, options?: { agentId?: string }) => string | undefined;
  lifecycleErrorRetryGraceMs?: number;
  isChatSendRunActive?: (runId: string) => boolean;
  settleTrackedTerminal?: AgentEventHandlerOptions["settleTrackedTerminal"];
  trackTrackedRunTerminalPersistence?: AgentEventHandlerOptions["trackTrackedRunTerminalPersistence"];
  resolveActiveLifecycleGenerationForRun?: (runId: string) => string | undefined;
  updateRunToolErrorSummary?: AgentEventHandlerOptions["updateRunToolErrorSummary"];
  resolveSessionActiveRunState?: AgentEventHandlerOptions["resolveSessionActiveRunState"];
  loadGatewaySessionLifecycleSnapshotForEvent?: AgentEventHandlerOptions["loadGatewaySessionLifecycleSnapshotForEvent"];
  persistGatewaySessionLifecycleEventForEvent?: AgentEventHandlerOptions["persistGatewaySessionLifecycleEventForEvent"];
  getSessionRowProjection?: AgentEventHandlerOptions["getSessionRowProjection"];
};

export function answerCandidate(
  itemId: string,
  progressText: string,
  status: "candidate" | "selected" | "superseded" = "candidate",
) {
  return {
    itemId,
    kind: "answer_candidate",
    title: "Answer candidate",
    phase: "update",
    status,
    progressText,
    source: "codex-app-server",
    hideFromChannelProgress: true,
  };
}

export function widgetResult(id: string, target = "assistant_message", title = id) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kind: "canvas",
          presentation: { target, title, sandbox: "scripts" },
          view: { id, url: `/__openclaw__/canvas/documents/${id}/index.html` },
        }),
      },
    ],
  };
}

export function createAgentEventTestHarness(params?: AgentEventTestHarnessOptions) {
  const nowSpy =
    params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
  const broadcast = vi.fn();
  const broadcastToConnIds = vi.fn();
  const nodeSendToSession = vi.fn();
  const nodeHasSessionSubscribers = vi.fn(() => true);
  const clearAgentRunContext = vi.fn();
  const clearTrackedActiveRun =
    vi.fn<NonNullable<AgentEventHandlerOptions["clearTrackedActiveRun"]>>();
  const agentRunSeq = new Map<string, number>();
  const chatRunState = createChatRunState();
  const toolEventRecipients = chatRunState.toolEventRecipients;
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();

  const handler = createAgentEventHandler({
    broadcast,
    broadcastToConnIds,
    nodeSendToSession,
    nodeHasSessionSubscribers,
    agentRunSeq,
    chatRunState,
    resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
    clearAgentRunContext,
    toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    loadGatewaySessionLifecycleSnapshotForEvent:
      params?.loadGatewaySessionLifecycleSnapshotForEvent ?? (() => ({ row: null })),
    persistGatewaySessionLifecycleEventForEvent:
      params?.persistGatewaySessionLifecycleEventForEvent ?? vi.fn(async () => undefined),
    lifecycleErrorRetryGraceMs: params?.lifecycleErrorRetryGraceMs,
    isChatSendRunActive: params?.isChatSendRunActive,
    clearTrackedActiveRun,
    settleTrackedTerminal: params?.settleTrackedTerminal,
    trackTrackedRunTerminalPersistence: params?.trackTrackedRunTerminalPersistence,
    resolveActiveLifecycleGenerationForRun: params?.resolveActiveLifecycleGenerationForRun,
    updateRunToolErrorSummary: params?.updateRunToolErrorSummary,
    resolveSessionActiveRunState: params?.resolveSessionActiveRunState,
    getSessionRowProjection: params?.getSessionRowProjection,
  });

  return {
    emit: emitAgentEvent.bind(undefined, handler),
    emitMany: emitAgentEvents.bind(undefined, handler),
    end: emitLifecycleEnd.bind(undefined, handler),
    register: registerChatRun.bind(undefined, chatRunState),
    registerNamed: registerNamedChatRun.bind(undefined, chatRunState),
    chat: () => chatBroadcastCalls(broadcast),
    agent: () => agentBroadcastCalls(broadcast),
    targetedChat: () => chatBroadcastCalls(broadcastToConnIds),
    targetedAgent: () => agentBroadcastCalls(broadcastToConnIds),
    deltas: () => chatDeltaTexts(broadcast),
    targetedDeltas: () => chatDeltaTexts(broadcastToConnIds),
    nodeChat: () => sessionChatCalls(nodeSendToSession),
    nodeAgent: () => sessionAgentCalls(nodeSendToSession),
    changes: () => sessionChangedCalls(broadcastToConnIds),
    nowSpy,
    broadcast,
    broadcastToConnIds,
    nodeSendToSession,
    nodeHasSessionSubscribers,
    clearAgentRunContext,
    clearTrackedActiveRun,
    agentRunSeq,
    chatRunState,
    toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    handler,
  };
}

export function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls.filter(([event]) => event === "chat");
}

function chatDeltaTexts(broadcast: ReturnType<typeof vi.fn>) {
  return chatBroadcastCalls(broadcast)
    .map(([, payload]) => payload as { state?: string; deltaText?: string })
    .filter((payload) => payload.state === "delta")
    .map((payload) => payload.deltaText);
}

export function agentBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls.filter(([event]) => event === "agent");
}

function sessionChangedCalls(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls.filter(([event]) => event === "sessions.changed");
}

function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
  return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
}

function sessionAgentCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
  return nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
}

function emitLifecycleEnd(handler: Parameters<typeof emitAgentEvent>[0], runId: string, seq = 2) {
  emitAgentEvent(handler, runId, "lifecycle", { phase: "end" }, { seq });
}

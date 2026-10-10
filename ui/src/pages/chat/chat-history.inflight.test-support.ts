import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import type { ChatEventPayload } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatHistoryHost } from "./chat-state-contract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { visibleCurrentAssistantStreamTail } from "./stream-reconciliation.ts";
import type { ToolStreamEntry } from "./tool-stream-contract.ts";
import type { handleAgentEvent } from "./tool-stream.ts";

export type TestState = ChatHistoryHost &
  Parameters<typeof handleAgentEvent>[0] & { requestUpdate: () => void };

export function createState(result: ChatHistoryResult): TestState {
  const host = makeChatHost({
    requestHandlers: { "chat.history": result },
    sessionKey: "main",
  });
  vi.spyOn(host.sessions, "reconcileMutation").mockResolvedValue({ status: "refreshed" });
  vi.spyOn(host.sessions, "reconcileRunTerminal").mockReturnValue(false);
  vi.spyOn(host.sessions, "listBranches").mockResolvedValue([]);
  onTestFinished(() => host.sessions.dispose());
  return {
    ...host,
    chatToolMessages: host.chatToolMessages ?? [],
    chatStreamSegments: host.chatStreamSegments ?? [],
    connectionEpoch: 1,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatStreamStartedAt: null,
    toolStreamById: host.toolStreamById ?? new Map<string, ToolStreamEntry>(),
    toolStreamOrder: host.toolStreamOrder ?? [],
    toolStreamSyncTimer: host.toolStreamSyncTimer ?? null,
    requestUpdate: vi.fn(),
  };
}

export function activeHistory(runId: string): ChatHistoryResult {
  return {
    messages: [],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: [runId],
      status: "running",
    },
    inFlightRun: { runId, text: "" },
  };
}

export const message = (
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  timestamp?: number,
) => ({
  role,
  content,
  ...(metadata ? { __openclaw: metadata } : {}),
  ...(timestamp ? { timestamp } : {}),
});
export function emit(
  state: TestState,
  runId: string,
  event: Omit<ChatEventPayload, "sessionKey" | "runId">,
) {
  handleChatGatewayEvent(state, { sessionKey: "main", runId, ...event });
}
export function delayed(history: ChatHistoryResult) {
  const response = createDeferred<ChatHistoryResult>();
  const state = createState(history);
  const request = vi.spyOn(state.client!, "request").mockReturnValue(response.promise);
  return { state, response, request };
}
export const tail = (state: TestState) =>
  visibleCurrentAssistantStreamTail(state, isHiddenAssistantStreamText);
export function renderedText(state: TestState) {
  return buildChatItems({
    paneId: "steer-regression",
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    streamSegments: state.chatStreamSegments,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    showToolCalls: true,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message: entry }) => extractText(entry)?.trim())
      : item.kind === "stream"
        ? [item.text.trim()]
        : [],
  );
}

export const event = (seq: number, stream: string, data: Record<string, unknown>) => ({
  runId: "run-live",
  seq,
  stream,
  ts: 899 + seq,
  sessionKey: "main",
  data,
});

export function failedHistory(): ChatHistoryResult {
  return {
    messages: [
      message(
        "user",
        "Inspect the unavailable project",
        { id: "first-user", idempotencyKey: "run-first:user", seq: 1 },
        1,
      ),
    ],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 2,
      status: "failed",
      hasActiveRun: false,
      lastRunId: "run-first",
      lastRunError:
        "ProjectCloneError: Git clone could not reach GitHub. Check the Gateway network connection and retry.",
    },
  };
}
export function steerPrompts(seq: number, timestamp = seq) {
  return {
    original: message("user", "Original prompt", { idempotencyKey: "active-run:user", seq: 1 }, 1),
    steer: message(
      "user",
      "Steer prompt",
      {
        id: "steer",
        idempotencyKey: "steer-run:user",
        seq,
        steerTargetRunId: "active-run",
      },
      timestamp,
    ),
  };
}
export const toolEvent = (call: string) => ({
  ...event(2, "tool", {
    toolCallId: call,
    name: "read",
    phase: "start",
    args: { path: "README.md" },
  }),
  ts: 1000,
});

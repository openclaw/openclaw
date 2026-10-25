// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { event, toolEvent } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { retireDeliveredQueuedUserTurn } from "./chat-send-support.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { admitStoredChatComposerQueueItemResult } from "./composer-queue-persistence.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import {
  applyChatCacheSnapshot,
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { handleAgentEvent } from "./tool-stream.ts";

function createState(handler: (params?: unknown) => unknown) {
  return makeChatHost({
    requestHandlers: { "chat.history": handler },
    sessionKey: "main",
    connectionEpoch: 1,
  });
}

function message(
  role: "assistant" | "user",
  content: unknown,
  id: string,
  seq: number,
  metadata = {},
) {
  return { role, content, __openclaw: { id, seq, ...metadata } };
}
const sessionInfo = (overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: "main",
  kind: "direct",
  sessionId: "session-cursor",
  updatedAt: 2,
  ...overrides,
});
const persisted = (row: ReturnType<typeof message>, extra = {}) => ({
  message: row,
  messageId: row["__openclaw"].id,
  messageSeq: row["__openclaw"].seq,
  ...extra,
});
function delta<T>(cursor: string, messages: T[], row: Partial<GatewaySessionRow> = {}) {
  return { kind: "delta", deltaCursor: cursor, messages, sessionInfo: sessionInfo(row) };
}
const fallback = (text: string, itemId: string) => ({
  itemId,
  replacementText: text,
  source: "segment",
});
const toolCall = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
const cachedSnapshot = (state: ReturnType<typeof createState>) =>
  readChatSessionSnapshot(state.chatMessagesBySession!, state, { sessionKey: state.sessionKey });

function seedCachedHistory(
  state: ReturnType<typeof createState>,
  messages: unknown[],
  deltaCursor?: string,
): ChatMessageCache {
  const cache: ChatMessageCache = new Map();
  state.chatMessagesBySession = cache;
  const snapshot = {
    ...(deltaCursor !== undefined ? { deltaCursor } : {}),
    displayedLeafEntryId: state.chatDisplayedLeafEntryId,
    messages,
    pagination: { hasMore: false, completeSnapshot: true } as const,
    sessionId: "session-cursor",
  };
  applyChatCacheSnapshot(state, snapshot);
  cacheChatSessionSnapshot(cache, state, { sessionKey: state.sessionKey }, snapshot);
  return cache;
}

async function loadHistoryWithBrowserTimers(state: ReturnType<typeof createState>): Promise<void> {
  vi.stubGlobal("window", globalThis);
  await loadChatHistory(state);
  await vi.waitFor(() => expect(state.chatToolMessages).toHaveLength(1));
}

describe("chat history cursor revalidation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("catches up a lagging split after a sibling advances", async () => {
    const cached = message("user", "First turn", "user-1", 1);
    const reply = message("assistant", "New reply", "answer-2", 2);
    const handler = vi.fn(async (params?: unknown) =>
      delta("cursor-2", asOptionalRecord(params)?.cursor === "cursor-1" ? [persisted(reply)] : []),
    );
    const first = createState(handler);
    const second = createState(handler);
    second.client = first.client;
    second.sessions = first.sessions;
    const cache = seedCachedHistory(first, [cached], "cursor-1");
    seedCachedHistory(second, [cached], "cursor-1");
    second.chatMessagesBySession = cache;
    await loadChatHistory(first);
    expect(first.chatMessages).toEqual([cached, reply]);
    expect(second.chatMessages).toEqual([cached]);
    await loadChatHistory(second);
    expect(second.chatMessages).toEqual([cached, reply]);
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-1", toolResultMaxChars: 2_000 }),
    );
  });

  it.each(["session", "agent", "transcript", "reset"] as const)(
    "does not reuse a pane cursor after its %s changes",
    async (transition) => {
      const handler = vi.fn(async () => ({
        messages: [message("assistant", "Replacement history", "replacement", 1)],
        sessionId: "replacement-session",
      }));
      const state = createState(handler);
      state.sessionKey = "global";
      state.assistantAgentId = "main";
      seedCachedHistory(state, [message("user", "Previous history", "previous", 1)], "old-cursor");
      if (transition === "session") {
        state.sessionKey = "agent:main:other";
      } else if (transition === "agent") {
        state.assistantAgentId = "other";
      } else if (transition === "transcript") {
        state.currentSessionId = "replacement-session";
      } else {
        reduceChatSessionProjection(state, { type: "sessionReset" });
      }
      await loadChatHistory(state);
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        expect.not.objectContaining({ cursor: expect.anything() }),
      );
      expect(state.chatMessages.map(extractText)).toEqual(["Replacement history"]);
    },
  );

  it("retains an attributed pending steer across a leaf advance before history-delta persistence", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const sessionKey = "agent:main:participant-steer";
    const sendRunId = "bob-send";
    const aliceFinal = {
      ...message("assistant", "Alice finished the command.", "alice-final", 4),
      timestamp: 2000,
    };
    const handler = vi.fn(async (): Promise<unknown> =>
      delta("cursor-4", [persisted(aliceFinal, { sessionKey, runId: "alice-run" })], {
        key: sessionKey,
        activeLeafEntryId: "alice-final",
        updatedAt: 2000,
        hasActiveRun: false,
        status: "done",
        lastRunId: "alice-run",
      }),
    );
    const state = createState(handler);
    state.sessionKey = sessionKey;
    state.chatDisplayedLeafEntryId = "alice-tool-result";
    seedCachedHistory(
      state,
      [
        message("user", "Run the long command.", "alice-user", 1, {
          idempotencyKey: "alice-run:user",
          senderId: "alice-profile",
          senderName: "Alice Proof",
        }),
        message("assistant", [toolCall("exec-call", "exec")], "alice-tool-call", 2),
        {
          role: "toolResult",
          toolCallId: "exec-call",
          content: "Command finished.",
          __openclaw: { id: "alice-tool-result", seq: 3 },
        },
      ],
      "cursor-3",
    );
    const queued: ChatQueueItem = {
      id: "bob-queued-send",
      text: "Reply exactly: BOB_STEER_ACK",
      createdAt: 1500,
      sendRunId,
      sendState: "sending",
      sendAttempts: 1,
      queueMode: "steer",
      sessionKey,
      sender: { id: "bob-profile", name: "Bob Proof" },
    };
    expect(
      admitStoredChatComposerQueueItemResult(
        state,
        captureChatOutboxAdmission(state, sessionKey, queued.agentId),
        queued,
      ),
    ).toBe("admitted");
    state.chatQueue = [queued];
    const renderedBobMessages = () =>
      buildChatItems({
        paneId: "participant-steer-cursor",
        sessionKey,
        runId: state.chatRunId,
        messages: state.chatMessages,
        queue: state.chatQueue,
        toolMessages: state.chatToolMessages,
        streamSegments: state.chatStreamSegments,
        stream: state.chatStream,
        streamStartedAt: state.chatStreamStartedAt,
        showToolCalls: true,
      }).flatMap((item) =>
        item.kind === "group" && item.role === "user"
          ? item.messages.filter(({ message: candidate }) => extractText(candidate) === queued.text)
          : [],
      );
    expect(renderedBobMessages()).toHaveLength(1);

    // Delivery retirement materializes the acknowledged turn before its durable row arrives.
    expect(await retireDeliveredQueuedUserTurn(state, sendRunId, { sessionKey })).toBe("retired");
    expect(state.chatQueue).toEqual([]);
    expect(renderedBobMessages()).toHaveLength(1);
    await loadChatHistory(state);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cursor-3" }));
    expect(state.chatDisplayedLeafEntryId).toBe("alice-final");
    expect(renderedBobMessages()).toHaveLength(1);

    const persistedBob = {
      ...message("user", queued.text, "bob-user", 5, {
        idempotencyKey: `${sendRunId}:user`,
        senderId: "bob-profile",
        senderName: "Bob Proof",
        recordTimestampMs: 2500,
      }),
      timestamp: queued.createdAt,
      idempotencyKey: `${sendRunId}:user`,
    };
    handler.mockResolvedValueOnce(
      delta("cursor-5", [persisted(persistedBob, { sessionKey, clientRunId: sendRunId })], {
        key: sessionKey,
        activeLeafEntryId: "bob-user",
        updatedAt: 2500,
        hasActiveRun: true,
        status: "running",
        lastRunId: "alice-run",
      }),
    );
    await loadChatHistory(state);

    expect(renderedBobMessages()).toHaveLength(1);
    expect(
      state.chatMessages.filter((candidate) => extractText(candidate) === queued.text),
    ).toEqual([persistedBob]);
  });

  it("retains live and terminal run ownership across an accepted delta leaf advance", async () => {
    const state = createState(() =>
      delta("cursor-2", [], {
        activeLeafEntryId: "next-leaf",
        updatedAt: 2,
        hasActiveRun: true,
      }),
    );
    state.chatDisplayedLeafEntryId = "previous-leaf";
    seedCachedHistory(state, [], "cursor-1");
    reduceChatSessionProjection(state, {
      type: "runTerminal",
      runId: "completed-run",
      status: "completed",
    });
    const projection = reduceChatSessionProjection(state, {
      type: "runDelta",
      runId: "active-run",
      message: message("assistant", "Still working.", "live-message", 1),
    });

    await loadChatHistory(state);

    const current = getChatSessionProjection(state);
    expect(current.scope.activeLeafEntryId).toBe("next-leaf");
    expect(current.runs).toBe(projection.runs);
  });

  it("keeps cached paint while replay hydrates prepared completion in place", async () => {
    const items: AgentActivityItem[] = [
      {
        itemId: "call-1",
        toolCallId: "call-1",
        kind: "tool",
        phase: "end",
        title: "Read file",
        status: "completed",
      },
    ];
    const call = toolCall("call-1", "read");
    const cached = message("assistant", [call], "assistant-tool", 1);
    const replayed = {
      ...cached,
      content: [call, { type: "toolResult", toolCallId: "call-1", text: "file contents" }],
    };
    const response = createDeferred<Record<string, unknown>>();
    const handler = vi.fn(() => response.promise);
    const state = createState(handler);
    seedCachedHistory(state, [cached], "cursor-1");

    const load = loadChatHistory(state);

    expect(state.chatMessages).toEqual([cached]);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "cursor-1", sessionKey: "main" }),
    );
    response.resolve({
      ...delta("cursor-2", [persisted(replayed, { sessionKey: "main" })]),
      activity: [{ messageId: "assistant-tool", items }],
    });
    await load;

    const hydrated = { ...replayed, activity: items };
    expect(state.chatMessages).toEqual([hydrated]);
    expect(cachedSnapshot(state)).toMatchObject({
      deltaCursor: "cursor-2",
      messages: [hydrated],
    });
  });

  it.each(["delta", "full"] as const)(
    "retires a missed failure after successful %s history and rejects stale replay",
    async (kind) => {
      const cached = message("user", "cached", "cached-user", 1, {
        idempotencyKey: "run-first:user",
      });
      const history = (
        cursor: string,
        messages: ReturnType<typeof message>[],
        row: Partial<GatewaySessionRow>,
      ) =>
        kind === "delta"
          ? delta(
              cursor,
              messages.map((entry) => persisted(entry, { runId: "run-retry" })),
              row,
            )
          : { messages: [cached, ...messages], sessionInfo: sessionInfo(row) };
      const failed = history("cursor-2", [], {
        status: "failed",
        hasActiveRun: false,
        lastRunId: "run-first",
        lastRunError:
          "Git clone could not reach GitHub. Check the Gateway network connection and retry.",
      });
      const handler = vi.fn(async (_params?: unknown): Promise<unknown> => failed);
      const state = createState(handler);
      if (kind === "delta") {
        seedCachedHistory(state, [cached], "cursor-1");
      }

      await loadChatHistory(state);

      expect(state.chatMessages).toEqual([cached]);
      expect(state.chatRunError?.summary).toContain(
        "Check the Gateway network connection and retry.",
      );
      if (kind === "delta") {
        expect(cachedSnapshot(state)?.deltaCursor).toBe("cursor-2");
      }

      const reply = message("assistant", "Recovery completed.", "retry-answer", 3, {
        idempotencyKey: "run-retry",
        runId: "run-retry",
      });
      const recovered =
        kind === "delta"
          ? [reply]
          : [
              message("user", "Try again", "retry-user", 2, { idempotencyKey: "run-retry:user" }),
              reply,
            ];
      handler.mockResolvedValueOnce(
        history("cursor-3", recovered, {
          updatedAt: 3,
          status: "done",
          hasActiveRun: false,
          lastRunId: "run-retry",
        }),
      );
      await loadChatHistory(state);

      if (kind === "delta") {
        expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "cursor-2" }));
      }
      expect(state.chatMessages).toEqual([cached, ...recovered]);
      expect(state.currentSessionId).toBe("session-cursor");
      expect(state.chatRunId).toBeNull();
      expect(state.chatRunError).toBeNull();
      expect(getChatSessionProjection(state).runs["run-first"]).toMatchObject({
        status: "error",
        errorMessage: failed.sessionInfo?.lastRunError,
      });
      handler.mockResolvedValueOnce(failed);
      await loadChatHistory(state);
      expect(state.chatRunError).toBeNull();
    },
  );

  it.each([
    { kind: "delta", persistedRunId: "run-other" },
    { kind: "full", persistedRunId: "run-live" },
  ] as const)(
    "restores active commentary once from $kind history with persisted owner $persistedRunId",
    async ({ kind, persistedRunId }) => {
      const cached = message("user", "cached", "cached-user", 1);
      const commentary = {
        ...message("assistant", "Checking the workspace", "persisted-commentary", 2, {
          runId: persistedRunId,
        }),
        openclawStreamFallback: fallback("Checking the workspace", "preamble-restored"),
      };
      const cachedMessages = [cached, commentary];
      const handler = vi.fn(async (_params?: unknown) => ({
        ...(kind === "delta"
          ? { kind: "delta", messages: [], deltaCursor: "cursor-2" }
          : { messages: cachedMessages }),
        sessionInfo: sessionInfo({
          hasActiveRun: true,
          activeRunIds: ["run-live"],
          status: "running",
        }),
        inFlightRun: {
          runId: "run-live",
          text: "",
          startedAt: 900,
          events: [
            event(1, "item", {
              kind: "preamble",
              itemId: "preamble-restored",
              progressText: "Checking the workspace",
            }),
            toolEvent("call-restored"),
            {
              ...event(3, "usage", {
                outputTokens: 695,
                context: { totalTokens: 1500, contextWindow: 8000 },
              }),
              ts: 1100,
            },
          ],
        },
      }));
      const state = createState(handler);
      if (kind === "delta") {
        seedCachedHistory(state, cachedMessages, "cursor-1");
      }

      await loadHistoryWithBrowserTimers(state);

      expect(state.chatRunId).toBe("run-live");
      expect(state.chatRunUsageById?.get("run-live")?.outputTokens).toBe(695);
      if (persistedRunId === "run-live") {
        expect(state.chatStreamSegments).toEqual([]);
      } else {
        expect(state.chatStreamSegments).toContainEqual(
          expect.objectContaining({
            itemId: "preamble-restored",
            runId: "run-live",
            text: "Checking the workspace",
            ts: 900,
          }),
        );
      }
      expect(state.chatMessages).toEqual(cachedMessages);
      expect(state.chatToolMessages).toContainEqual(
        expect.objectContaining({
          runId: "run-live",
          toolCallId: "call-restored",
          content: [expect.objectContaining({ type: "toolcall", name: "read" })],
        }),
      );
    },
  );

  it.each([
    { terminal: "aborted", historyFirst: false },
    { terminal: "error", historyFirst: false },
    { terminal: "final", historyFirst: true },
  ] as const)(
    "adopts live commentary once across $terminal and cursor catch-up (history first: $historyFirst)",
    async ({ terminal, historyFirst }) => {
      const runId = "commentary-run";
      const text = "Checking the workspace.";
      const prompt = {
        ...message("user", "Inspect the workspace", "user", 1, { idempotencyKey: `${runId}:user` }),
        timestamp: 1,
      };
      const commentary = {
        ...message("assistant", text, "commentary", 2, { runId, mirrorOrigin: "codex-app-server" }),
        timestamp: 2,
        openclawStreamFallback: fallback(text, "item-1"),
      };
      // Intermediate Codex rows carry producer ownership in metadata, without a terminal run envelope.
      const payload = persisted(commentary, { sessionKey: "main" });
      const handler = vi.fn(async () =>
        delta("cursor-2", [payload], {
          updatedAt: 3,
          hasActiveRun: historyFirst,
          activeRunIds: historyFirst ? [runId] : [],
        }),
      );
      const state = createState(handler);
      seedCachedHistory(state, [prompt], "cursor-1");
      state.chatRunId = runId;
      const preamble = (seq: number) => ({
        ...event(seq, "item", {
          kind: "preamble",
          itemId: "item-1",
          progressText: text,
        }),
        runId,
        ts: 2,
      });
      handleAgentEvent(state, preamble(1));
      applySessionMessagePayload(state, payload, true, { kind: "live", activeRunId: runId });
      expect(state.chatMessages).toEqual([prompt, commentary]);
      expect(state.chatStreamSegments).toEqual([]);
      if (historyFirst) {
        await loadChatHistory(state);
      }
      handleChatGatewayEvent(state, {
        runId,
        sessionKey: "main",
        state: terminal,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Workspace inspected." }],
          timestamp: 3,
        },
      });
      if (!historyFirst) {
        await loadChatHistory(state);
      }
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cursor-1" }));
      expect(state.chatMessages.map(extractText)).toEqual([
        "Inspect the workspace",
        text,
        "Workspace inspected.",
      ]);
      expect(state.chatMessages[1]).toEqual(commentary);
      expect(state.chatStreamSegments).toEqual([]);
      // Reconnect replay retains the same row and cannot revive its live segment.
      await loadChatHistory(state);
      handleAgentEvent(state, preamble(2));
      expect(state.chatMessages.filter((candidate) => extractText(candidate) === text)).toEqual([
        commentary,
      ]);
      expect(state.chatStreamSegments).toEqual([]);
    },
  );

  it("clears a rejected cursor before falling back to a full tail fetch", async () => {
    const cached = message("user", "cached", "cached-user", 1);
    const fresh = message("assistant", "fresh", "fresh-assistant", 2);
    const handler = vi
      .fn()
      .mockImplementationOnce(async () => ({ kind: "reset" }))
      .mockImplementationOnce(async () => {
        expect(cachedSnapshot(state)?.deltaCursor).toBeUndefined();
        return {
          messages: [cached, fresh],
          deltaCursor: "cursor-fresh",
          sessionId: "session-cursor",
        };
      });
    const state = createState(handler);
    seedCachedHistory(state, [cached], "cursor-stale");

    await loadChatHistory(state);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ cursor: "cursor-stale" }));
    expect(handler.mock.calls[1]?.[0]).not.toHaveProperty("cursor");
    expect(state.chatMessages).toEqual([cached, fresh]);
    expect(cachedSnapshot(state)?.deltaCursor).toBe("cursor-fresh");
  });
});

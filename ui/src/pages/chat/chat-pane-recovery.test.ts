/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { admitStoredChatComposerQueueItemResult } from "./composer-queue-persistence.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

function sessionsResult(row: GatewaySessionRow): SessionsListResult {
  return { ...createSessionsListResult({ defaultsModel: null }), sessions: [row] };
}

function queuedSendFixture() {
  vi.stubGlobal("sessionStorage", createStorageMock());
  const listRefresh = createDeferred<SessionsListResult>();
  const active: GatewaySessionRow = {
    key: "agent:main",
    kind: "direct",
    updatedAt: 10,
    activeRunIds: ["server-run"],
    hasActiveRun: true,
    status: "running",
  };
  const idle: GatewaySessionRow = {
    ...active,
    updatedAt: 11,
    activeRunIds: [],
    hasActiveRun: false,
    lastRunId: "server-run",
    status: "done",
  };
  const messages: unknown[] = [];
  const host = makeChatHost({
    chatQueue: [
      {
        id: "queued-after-server-run",
        text: "send after idle",
        createdAt: 1,
        sendAttempts: 0,
        sendRunId: "queued-send-run",
        sendState: "waiting-idle",
        sessionKey: "agent:main",
      },
    ],
    requestHandlers: {
      "sessions.list": () => listRefresh.promise,
      "chat.history": () => ({ messages, sessionInfo: idle }),
      "chat.send": (params: { message: string; idempotencyKey: string }) => {
        messages.push({
          role: "user",
          content: params.message,
          __openclaw: {
            id: "queued-user",
            seq: 1,
            idempotencyKey: `${params.idempotencyKey}:user`,
          },
        });
        return { runId: params.idempotencyKey, status: "started", messageSeq: 1 };
      },
    },
    sessionsResult: sessionsResult(active),
  });
  const admission = captureChatOutboxAdmission(host, host.sessionKey);
  expect(admitStoredChatComposerQueueItemResult(host, admission, host.chatQueue[0]!)).toBe(
    "admitted",
  );
  const { pane } = createTestChatPane({ client: host.client!, sessions: host.sessions });
  pane.state = host as unknown as ChatPageHost;
  pane.applySessionsState(host.sessions.state);
  const unsubscribe = host.sessions.subscribe((state) => pane.applySessionsState(state));
  cleanups.push(() => {
    pane.active = false;
    unsubscribe();
    host.sessions.dispose();
  });
  return {
    idle,
    host,
    listRefresh,
    pane,
    calls: (method: string) => host.request.mock.calls.filter(([name]) => name === method),
  };
}

it.each(["publication", "event"] as const)(
  "recovers the saved first reply after a terminal row %s",
  async (delivery) => {
    const runId = "run-missed-terminal";
    const active: GatewaySessionRow = {
      key: "agent:main:first-reply",
      sessionId: "first-session",
      kind: "direct",
      updatedAt: 10,
      activeRunIds: [runId],
      hasActiveRun: true,
      status: "running",
    };
    const idle: GatewaySessionRow = {
      ...active,
      updatedAt: 20,
      activeRunIds: [],
      hasActiveRun: false,
      lastRunId: runId,
      status: "done",
    };
    const prompt = { role: "user", content: "Say hello", __openclaw: { id: "prompt", seq: 1 } };
    const reply = {
      role: "assistant",
      content: "Hello!",
      __openclaw: { id: "reply", seq: 2, runId },
    };
    const host = makeChatHost({
      sessionKey: active.key,
      currentSessionId: active.sessionId,
      chatRunId: runId,
      chatStream: delivery === "publication" ? "Hello!" : null,
      chatMessages: [prompt],
      sessionsResult: sessionsResult(active),
      requestHandlers: {
        "chat.history": { messages: [prompt, reply], sessionId: idle.sessionId, sessionInfo: idle },
        "sessions.list": sessionsResult(active),
      },
    });
    const { pane } = createTestChatPane({ client: host.client!, sessions: host.sessions });
    pane.state = host as unknown as ChatPageHost;
    pane.applySessionsState(host.sessions.state);
    const unsubscribe = host.sessions.subscribe((state) => pane.applySessionsState(state));
    cleanups.push(unsubscribe);

    if (delivery === "publication") {
      host.sessions.reconcile(idle);
    } else {
      host.sessionsResult = sessionsResult(idle);
      handlePageGatewayEvent(
        pane.state,
        {
          type: "event",
          event: "sessions.changed",
          payload: { ...idle, reason: "agent.run.ended" },
        },
        () => true,
        { applied: true, row: idle },
      );
    }

    expect(host).toMatchObject({ chatRunId: null, chatStream: null });
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    const history = getChatHistoryLoadState(host);
    if (history.phase === "in-flight") {
      await history.promise;
    }
    expect(host.chatMessages).toEqual([prompt, reply]);
    pane.applySessionsState(host.sessions.state);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
  },
);

it("releases a restored queued send when the canonical session state records idle", async () => {
  const { pane, host, listRefresh, idle, calls } = queuedSendFixture();
  pane.active = true;
  await vi.waitFor(() =>
    expect(host.request.mock.calls.map(([method]) => method)).toEqual(["sessions.list"]),
  );

  listRefresh.resolve(sessionsResult(idle));
  await vi.waitFor(() => expect(host.chatQueue).toEqual([]));
  expect(calls("chat.send")).toHaveLength(1);
});

it("keeps a queued send parked after a non-canonical idle publication", async () => {
  const { host, idle, calls } = queuedSendFixture();
  host.sessions.reconcile(idle);
  await Promise.resolve();

  expect(host.sessions.canonicalListRevision).toBe(0);
  expect(host.chatQueue).toHaveLength(1);
  expect([...calls("chat.history"), ...calls("chat.send")]).toEqual([]);
});

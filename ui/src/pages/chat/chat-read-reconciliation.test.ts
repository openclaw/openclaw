/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { subscribeChatOutboxProjection } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
} from "./composer-persistence.ts";

const selected = "agent:main:selected";
const queued = "agent:main:queued";
const foreign = "agent:main:foreign";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function activeHistory(): ChatHistoryResult {
  return {
    messages: [],
    sessionInfo: {
      key: queued,
      kind: "direct",
      updatedAt: 1,
      status: "running",
      hasActiveRun: true,
      sessionId: "queued-session",
    },
  };
}

function pageHost<T extends ReturnType<typeof makeChatHost>>(host: T) {
  const { pane, state } = createTestChatPane({
    client: expectDefined(host.client, "fixture client"),
    sessions: host.sessions,
  });
  onTestFinished(() => pane.disconnectedCallback());
  return Object.assign(state, host);
}

function outboxHost(history: () => ChatHistoryResult | Promise<ChatHistoryResult>) {
  const host = pageHost(
    makeChatHost({
      sessionKey: selected,
      requestHandlers: { "chat.history": history },
    }),
  );
  onTestFinished(() => host.sessions.dispose());
  const item = {
    id: "accepted-draft",
    sendRunId: "accepted-run",
    sessionKey: queued,
    sessionId: "queued-session",
    text: "Retain this accepted user input",
    createdAt: 1,
    sendAttempts: 1,
    sendState: "waiting-reconnect" as const,
  };
  expect(
    admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, queued), item),
  ).toBe(true);
  return host;
}

function sessionEvent(sessionKey: string, event = "sessions.changed"): GatewayEventFrame {
  return {
    type: "event",
    event,
    payload: { sessionKey, phase: "message", hasActiveRun: true, updatedAt: 2 },
  };
}

it("publishes a real recovery-owner change to subscribed panes during a foreign event", () => {
  const host = pageHost(makeChatHost({ sessionKey: selected, requestHandlers: {} }));
  const client = expectDefined(host.client, "shared client");
  const peer = pageHost(makeChatHost({ client, sessions: host.sessions, sessionKey: selected }));
  const paint = vi.fn();
  const peerPaint = vi.fn();
  host.requestUpdate = paint;
  peer.requestUpdate = peerPaint;
  const stopHost = subscribeChatOutboxProjection(host);
  const stopPeer = subscribeChatOutboxProjection(peer);
  onTestFinished(() => {
    stopPeer();
    stopHost();
    host.sessions.dispose();
  });
  const item = (id: string, recoveryScope: string): ChatQueueItem => ({
    id,
    text: id,
    sessionKey: selected,
    createdAt: 1,
    sendState: "failed",
    attachmentPayload: { key: `${id}-payload`, recoveryScope, tabId: "fixture-tab" },
    attachmentStorageError: "missing",
  });
  expect(
    admitStoredChatComposerQueueItem(
      host,
      captureChatOutboxAdmission(host, selected),
      item("old-owner", client.recoveryScope!),
    ),
  ).toBe(true);
  const replacement = createTestGatewayClient(async () => ({}));
  vi.spyOn(replacement, "recoveryScope", "get").mockReturnValue("replacement-scope");
  const writer = makeChatHost({ client: replacement, sessionKey: selected });
  onTestFinished(() => writer.sessions.dispose());
  expect(
    admitStoredChatComposerQueueItem(
      writer,
      captureChatOutboxAdmission(writer, selected),
      item("new-owner", "replacement-scope"),
    ),
  ).toBe(true);
  expect(host.chatQueue.map((row) => row.id)).toEqual(["old-owner"]);
  paint.mockClear();
  peerPaint.mockClear();

  vi.spyOn(client, "recoveryScope", "get").mockReturnValue("replacement-scope");
  handlePageGatewayEvent(host, sessionEvent(foreign), () => false);
  expect(host.chatQueue.map((row) => row.id)).toEqual(["new-owner"]);
  expect(peer.chatQueue.map((row) => row.id)).toEqual(["new-owner"]);
  expect(paint).toHaveBeenCalledTimes(1);
  expect(peerPaint).toHaveBeenCalledTimes(1);
});

it.each(
  ["chat", "session.message", "sessions.changed"].flatMap((event) =>
    [false, true].map((matching) => ({ event, matching })),
  ),
)(
  "renders only its scoped $event change in a retained pane (matching: $matching)",
  ({ event, matching }) => {
    const host = pageHost(makeChatHost({ sessionKey: selected, requestHandlers: {} }));
    onTestFinished(() => host.sessions.dispose());
    const requestUpdate = vi.fn();
    const frame = vi.fn(() => 1);
    host.requestUpdate = requestUpdate;
    vi.stubGlobal("requestAnimationFrame", frame);
    handlePageGatewayEvent(
      host,
      {
        type: "event",
        event,
        payload: {
          sessionKey: matching ? selected : foreign,
          runId: "event-run",
          ...(event === "chat"
            ? { state: "delta", deltaText: "Streaming result" }
            : { reason: "label" }),
        },
      },
      () => false,
    );
    expect(frame.mock.calls.length + requestUpdate.mock.calls.length).toBe(matching ? 1 : 0);
    if (!matching) {
      expect(host.chatMessages).toEqual([]);
      expect(host.chatRunId).toBeNull();
    }
  },
);

it.each(
  [false, true].flatMap((changed) =>
    [0, 7].flatMap((peerEpoch) =>
      [selected, queued].map((peerSession) => ({ changed, peerEpoch, peerSession })),
    ),
  ),
)(
  "joins a passive reader for $peerSession at epoch $peerEpoch and preserves events (changed: $changed)",
  async ({ changed, peerEpoch, peerSession }) => {
    const first = createDeferred<ChatHistoryResult>();
    let reads = 0;
    const host = outboxHost(() => (++reads === 1 ? first.promise : activeHistory()));
    const peer = makeChatHost({
      client: host.client,
      sessions: host.sessions,
      sessionKey: peerSession,
      connectionEpoch: peerEpoch,
    });
    const event = sessionEvent(queued);
    const a = resumeStoredChatOutboxes(host, event);
    const passive = resumeStoredChatOutboxes(peer);
    const b = resumeStoredChatOutboxes(peer, event);
    const fresh = changed ? resumeStoredChatOutboxes(peer, sessionEvent(queued)) : undefined;
    try {
      expect(reads).toBe(1);
    } finally {
      first.resolve(activeHistory());
      await Promise.all([a, b, passive, fresh]);
    }
    expect(reads).toBe(changed ? 2 : 1);
    await resumeStoredChatOutboxes(peer, event);
    expect(reads).toBe(changed ? 2 : 1);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe("accepted-run");
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  },
);

it.each(["sessions.changed", "session.message"])(
  "does not reconcile unrelated stored scopes for a foreign %s",
  async (event) => {
    const host = outboxHost(activeHistory);
    handlePageGatewayEvent(host, sessionEvent(foreign, event), () => false);
    await Promise.resolve();
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe("accepted-run");
    await resumeStoredChatOutboxes(host);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
  },
);

it("keeps global outbox event recovery bound to the event's agent", async () => {
  const host = makeChatHost({
    sessionKey: selected,
    requestHandlers: { "chat.history": activeHistory() },
  });
  onTestFinished(() => host.sessions.dispose());
  for (const agentId of ["main", "work"]) {
    expect(
      admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, "global", agentId), {
        id: agentId,
        sendRunId: `${agentId}-run`,
        sessionKey: "global",
        agentId,
        text: agentId,
        createdAt: 1,
        sendAttempts: 1,
        sendState: "waiting-reconnect",
      }),
    ).toBe(true);
  }
  await resumeStoredChatOutboxes(host, sessionEvent("global"));
  expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
  await resumeStoredChatOutboxes(host, {
    ...sessionEvent("global"),
    payload: { sessionKey: "global", agentId: "work", hasActiveRun: true },
  });
  expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toEqual([
    [
      "chat.history",
      { sessionKey: "global", agentId: "work", inputRunIds: ["work-run"], limit: 1000 },
    ],
  ]);
  expect(listStoredChatOutboxes(host)).toHaveLength(2);
});

it.each(["session", "connection"])(
  "retires a queued history refresh after its %s changes",
  async (change) => {
    const pending = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      sessionKey: selected,
      requestHandlers: { "chat.history": () => pending.promise },
    });
    onTestFinished(() => host.sessions.dispose());
    const initial = loadChatHistory(host, { deferBranches: true });
    const refresh = loadChatHistory(host, { deferBranches: true, supersedeInFlight: true });
    if (change === "session") {
      host.sessionKey = foreign;
    } else {
      host.connectionEpoch += 1;
    }
    pending.resolve({ messages: [{ role: "assistant", content: "Retired" }] });
    await Promise.all([initial, refresh]);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    expect(host.chatMessages).toEqual([]);
  },
);

it("waits for raw history settlement and coalesces custody events into one fresh read", async () => {
  const reads: Array<{
    pending: ReturnType<typeof createDeferred<ChatHistoryResult>>;
    signal?: AbortSignal;
    params: unknown;
  }> = [];
  const host = pageHost(makeChatHost({ sessionKey: selected, requestHandlers: {} }));
  onTestFinished(() => host.sessions.dispose());
  host.request.mockImplementation((method, params, options) => {
    if (method !== "chat.history") {
      return Promise.resolve({});
    }
    const pending = createDeferred<ChatHistoryResult>();
    reads.push({ pending, signal: options?.signal, params });
    return pending.promise;
  });
  const initial = loadChatHistory(host, { deferBranches: true });
  for (let index = 0; index < 3; index += 1) {
    handlePageGatewayEvent(
      host,
      {
        type: "event",
        event: "sessions.changed",
        payload: { sessionKey: selected, reason: "agent.input.settled" },
      },
      () => false,
    );
  }
  const fresh = loadChatHistory(host, { deferBranches: true });
  const response = (content: string): ChatHistoryResult => ({
    messages: [{ role: "assistant", content }],
    sessionId: "current-session",
    sessionInfo: {
      key: selected,
      kind: "direct",
      updatedAt: 4,
      sessionId: "current-session",
      hasActiveRun: false,
      status: "done",
    },
  });
  try {
    expect(reads).toHaveLength(1);
    expect(reads[0]?.signal?.aborted).toBe(false);
    host.chatQueue = [
      { id: "new-custody", sendRunId: "new-run", text: "new", createdAt: 3, sendAttempts: 1 },
    ];
    reads[0]!.pending.resolve(response("Stale history"));
    await initial;
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(host.chatMessages).toEqual([]);
    expect(reads[1]?.params).toMatchObject({ inputRunIds: ["new-run"] });
    reads[1]!.pending.resolve(response("Fresh history"));
    await fresh;
    expect(host.chatMessages).toEqual([{ role: "assistant", content: "Fresh history" }]);
  } finally {
    for (const read of reads) {
      read.pending.resolve(response("Cleanup"));
    }
    await Promise.all([initial, fresh]);
  }
});

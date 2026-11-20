import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
// @vitest-environment node
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { reloadChatDocumentStorage } from "./chat-delivery-attachments.test-support.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { subscribeChatOutboxQueue } from "./chat-outbox-queue.ts";
import { chatProviderReviewRow, holdProviderReviewQueuedInputs } from "./chat-provider-review.ts";
import { flushChatQueueForEvent, retryQueuedChatMessage } from "./chat-send-actions.ts";
import { deliverChatQueueItem } from "./chat-send-delivery.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { ChatComposerPersistence } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

const paused: GatewaySessionRow = {
  key: "agent:main:main",
  agentId: "main",
  kind: "direct",
  sessionId: "review-session",
  updatedAt: 10,
  snapshotAt: 10,
  providerReview: {
    id: "review-one",
    runId: "stopped-run",
    explanation: "The requested cleanup included files outside the selected project.",
    continuationMessage: "Continue within the selected project only.",
    canContinue: true,
  },
};
const continuedRow = (at: number): GatewaySessionRow => ({
  ...paused,
  providerReview: undefined,
  updatedAt: at,
  snapshotAt: at,
});
const queueItem = (id: string, text = `Retained ${id} input`) => ({
  id,
  text,
  createdAt: 1,
  sessionKey: paused.key,
  agentId: "main",
  sendState: "waiting-idle" as const,
  sendRunId: `unsent-${id}`,
});
function reviewHost(
  request: ReturnType<typeof makeRequestMock>,
  row: GatewaySessionRow,
  overrides: Parameters<typeof makeChatHost>[0] = {},
) {
  return makeChatHost({
    client: createTestGatewayClient(request),
    sessionKey: row.key,
    currentSessionId: row.sessionId,
    chatHistoryPagination: { hasMore: false },
    sessionsResult: sessionsResult([row], row.snapshotAt ?? 0),
    ...overrides,
  });
}
type ReviewHost = ReturnType<typeof reviewHost>;
async function refreshHistory(host: ReviewHost) {
  await loadChatHistory(host, { deferBranches: true });
  await flushChatQueueForEvent(host);
}
async function createReviewHost(
  request: ReturnType<typeof makeRequestMock>,
  initialRow: GatewaySessionRow,
  chatMessage: string,
) {
  const client = createTestGatewayClient(request);
  const { gateway, emitEvent } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const host = reviewHost(request, initialRow, { client, sessions, chatMessage });
  const publish = (row: Partial<GatewaySessionRow>, clearReview = false) =>
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: paused.key,
        agentId: "main",
        session: clearReview ? { ...row, providerReview: null } : row,
      },
    });
  return { host, publish };
}

it.each([
  { selected: " MAIN ", candidates: ["other", "agent:main:main", "main"], index: 1 },
  { selected: " ", candidates: ["", " "], index: -1 },
  {
    selected: "agent:main:matrix:group:Room",
    candidates: ["agent:main:matrix:group:room", "AGENT:MAIN:MATRIX:GROUP:Room"],
    index: 1,
  },
  { selected: " GLOBAL ", candidates: ["global", "global"], index: 1 },
])("keeps provider-review row selection for $selected", ({ selected, candidates, index }) => {
  const rows = candidates.map((key, candidate) => ({
    ...paused,
    key,
    agentId: candidate === 0 ? "other" : "main",
  }));
  const fallback = { ...paused, key: selected };
  const host = {
    sessionKey: selected,
    sessionsResult: sessionsResult(rows, 1),
    sessions: {
      state: {
        ...makeChatHost().sessions.state,
        result: sessionsResult([fallback], 1),
        agentId: "main",
      },
    },
  };
  expect(chatProviderReviewRow(host, selected, "main")).toBe(index < 0 ? undefined : rows[index]);
  host.sessionsResult = sessionsResult([], 1);
  expect(chatProviderReviewRow(host, selected, "main")).toBe(index < 0 ? undefined : fallback);
});

it("holds composer and queued inputs across the provider pause and only retries an explicitly selected row", async () => {
  let row = paused;
  const request = makeRequestMock({
    "chat.history": () => ({ sessionInfo: row, sessionId: row.sessionId, messages: [] }),
    "sessions.list": () => sessionsResult([row], row.snapshotAt ?? 0),
    "chat.send": { runId: "accepted-input", status: "started" },
  });
  const { host, publish } = await createReviewHost(request, row, "Keep this draft");
  for (const id of ["first", "second"]) {
    expect(
      admitQueuedMessageForSession(
        host,
        {
          ...captureChatOutboxAdmission(host, paused.key, "main"),
          scope: { sessionKey: paused.key, agentId: "main" },
          awaitingDefaults: false,
        },
        queueItem(id),
      ),
    ).toBe(true);
  }
  await handleSendChat(host);
  await flushChatQueueForEvent(host);
  await retryQueuedChatMessage(host, "first");
  expect(host.chatMessage).toBe("Keep this draft");
  expect(requestCalls(request, "chat.send")).toHaveLength(0);
  expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject([
    { id: "first", text: "Retained first input", sendState: "held" },
    { id: "second", text: "Retained second input", sendState: "held" },
  ]);

  row = continuedRow(11);
  publish(row, true);
  expect(chatProviderReviewRow(host)?.providerReview).toBeUndefined();
  await flushChatQueueForEvent(host);
  expect(requestCalls(request, "chat.send")).toHaveLength(0);
  await retryQueuedChatMessage(host, "first");
  const sends = requestCalls(request, "chat.send");
  expect(sends).toHaveLength(1);
  expect(sends[0]?.[1]).toMatchObject({ message: "Retained first input" });
  expect(listStoredChatOutboxes(host)[0]?.queue.find(({ id }) => id === "second")).toMatchObject({
    id: "second",
    text: "Retained second input",
    sendState: "held",
  });
});

it("keeps provider review receipts through partial events and rejects a stale read after authoritative clearing", async () => {
  const request = makeRequestMock({ "sessions.list": sessionsResult([paused], 10) });
  const { host, publish } = await createReviewHost(request, paused, "");
  const { sessions } = host;
  const readBeforeClear = sessions.captureReconcile();
  const partial = (at: number) => ({
    key: paused.key,
    sessionId: paused.sessionId,
    updatedAt: at,
    snapshotAt: at,
  });
  publish({ ...partial(11), label: "Renamed" });
  expect(sessions.state.result?.sessions[0]?.providerReview).toEqual(paused.providerReview);
  publish(partial(12), true);
  readBeforeClear(paused);
  expect(sessions.state.result?.sessions[0]?.providerReview).toBeUndefined();
});

it("keeps a paused queue input held when its earlier settings wait finishes after continuation", async () => {
  const settings = createDeferred<boolean>();
  const waiting = createDeferred();
  const request = makeRequestMock({ "chat.send": { status: "started" } });
  const host = reviewHost(request, continuedRow(10));
  const item = queueItem("settings-delayed-input", "Keep this queued input");
  expect(
    admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, paused.key, "main"), item),
  ).toBe(true);
  const stop = subscribeChatOutboxQueue(host, () => {
    if (host.chatQueue[0]?.sendState === "waiting-model") {
      waiting.resolve();
    }
  });
  try {
    const delivery = deliverChatQueueItem(host, item, { pendingSettings: settings.promise });
    await waiting.promise;
    holdProviderReviewQueuedInputs(host);
    settings.resolve(true);
    await delivery;
    await flushChatQueueForEvent(host);
    expect(requestCalls(request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      text: item.text,
      sendState: "held",
      sendRunId: item.sendRunId,
    });
  } finally {
    stop();
  }
});

it.each(["lost-ack", "accepted-unconsumed"] as const)(
  "transfers %s input to server custody across pause clearing and reload",
  async (outcome) => {
    let row = continuedRow(9);
    let attemptedRunId: string | undefined;
    let attempts = 0;
    let consumed = false;
    const request = makeRequestMock({
      "sessions.list": () => sessionsResult([row], row.snapshotAt ?? 0),
      "chat.history": () => {
        const ids = attemptedRunId ? [attemptedRunId] : [];
        const items = consumed
          ? []
          : ids.map((runId) => ({
              id: "accepted-input",
              runId,
              acceptedAt: 1,
              state: "interrupted",
              message: { role: "user", content: "Keep this delivery identity" },
            }));
        return {
          messages: [],
          sessionId: row.sessionId,
          sessionInfo: { ...row, hasActiveRun: false, status: "done" },
          pendingInputs: { items, total: items.length },
          inputReceipts: ids.map((runId) =>
            Object.assign(
              { runId, state: consumed ? "consumed" : "pending" },
              consumed ? { consumedByEventId: "server-recovered-input" } : {},
            ),
          ),
        };
      },
      "chat.send": (params: unknown) => {
        const runId = requireRecord(params, "chat.send").idempotencyKey;
        if (typeof runId !== "string") {
          throw new Error("Expected run ID");
        }
        attempts += 1;
        attemptedRunId = runId;
        if (attempts === 1) {
          if (outcome === "lost-ack") {
            throw new Error("Gateway disconnected before acknowledgment");
          }
          return { runId, status: "started" };
        }
        return { runId, status: "started", messageSeq: 1 };
      },
    });
    const { host, publish } = await createReviewHost(request, row, "Keep this delivery identity");
    await handleSendChat(host);
    if (outcome === "lost-ack") {
      expect(host.chatQueue[0]).toMatchObject({
        sendAttempts: 1,
        sendState: "waiting-reconnect",
        sendRunId: attemptedRunId,
      });
    } else {
      expect(host.chatQueue).toEqual([]);
      expect(listStoredChatOutboxes(host)).toEqual([]);
    }
    row = paused;
    publish(row);
    expect(chatProviderReviewRow(host)?.providerReview).toEqual(paused.providerReview);
    await flushChatQueueForEvent(host);
    if (outcome === "lost-ack") {
      expect(host.chatQueue[0]).toMatchObject({
        text: "Keep this delivery identity",
        sendState: "held",
        sendAttempts: 1,
        sendRunId: attemptedRunId,
      });
    }

    row = continuedRow(11);
    publish(row, true);
    await refreshHistory(host);
    expect(host.chatQueue).toEqual([]);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(getChatHistoryLoadState(host)).toMatchObject({ phase: "committed" });
    const expectPending = (target: ReviewHost) =>
      expect(target.chatPendingInputs?.page.items).toMatchObject([
        { runId: attemptedRunId, state: "interrupted" },
      ]);
    expectPending(host);
    reloadChatDocumentStorage([]);
    const reloaded = reviewHost(request, row);
    new ChatComposerPersistence(() => reloaded).restore();
    expect(reloaded.chatQueue).toEqual([]);
    await refreshHistory(reloaded);
    expectPending(reloaded);
    consumed = true;
    await refreshHistory(reloaded);
    expect(listStoredChatOutboxes(reloaded)).toEqual([]);
    expect(attempts).toBe(1);
  },
);

it.each(["consumed", "pending", "disconnected"] as const)(
  "preserves in-flight delivery identity when its late outcome is %s after review clears",
  async (outcome) => {
    const started = createDeferred();
    const acknowledgment = createDeferred<unknown>();
    const initial = continuedRow(9);
    const request = makeRequestMock({
      "sessions.list": () => sessionsResult([initial], 9),
      "chat.send": () => {
        started.resolve();
        return acknowledgment.promise;
      },
    });
    const { host, publish } = await createReviewHost(request, initial, "Already in flight");
    const sending = handleSendChat(host);
    await started.promise;
    const inFlight = host.chatQueue[0];
    expect(inFlight).toMatchObject({ sendState: "sending", sendAttempts: 1 });
    host.sessionsResult = sessionsResult([paused], 10);
    host.sessions.reconcile(paused);
    expect(holdProviderReviewQueuedInputs(host)).toBe(true);
    expect(host.chatQueue[0]).toMatchObject({
      id: inFlight?.id,
      text: inFlight?.text,
      createdAt: inFlight?.createdAt,
      sessionKey: inFlight?.sessionKey,
      sendRunId: inFlight?.sendRunId,
      sendAttempts: 1,
      sendState: "held",
      sendError: expect.any(String),
    });
    const continued = continuedRow(11);
    host.sessionsResult = sessionsResult([continued], 11);
    publish(continued, true);
    expect(chatProviderReviewRow(host)?.providerReview).toBeUndefined();
    if (outcome === "disconnected") {
      acknowledgment.reject(new Error("Gateway disconnected before acknowledgment"));
    } else {
      acknowledgment.resolve({
        runId: inFlight?.sendRunId,
        status: "started",
        ...(outcome === "consumed" ? { messageSeq: 1 } : {}),
      });
    }
    await sending;
    await flushChatQueueForEvent(host);
    expect(requestCalls(request, "chat.send")).toHaveLength(1);
    if (outcome !== "disconnected") {
      expect(listStoredChatOutboxes(host)).toEqual([]);
    } else {
      expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject([
        {
          text: inFlight?.text,
          sendRunId: inFlight?.sendRunId,
          sendAttempts: 1,
          sendState: "held",
        },
      ]);
    }
  },
);

// @vitest-environment node
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { reloadChatDocumentStorage } from "./chat-delivery-attachments.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { chatProviderReviewRow, holdProviderReviewQueuedInputs } from "./chat-provider-review.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { flushChatQueueForEvent, retryQueuedChatMessage } from "./chat-send-actions.ts";
import { deliverChatQueueItem } from "./chat-send-delivery.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes, restoreChatComposerState } from "./composer-persistence.ts";
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

it("holds composer and queued inputs across the provider pause and only retries an explicitly selected row", async () => {
  let row = paused;
  const request = makeRequestMock({
    "chat.history": () => ({ sessionInfo: row, sessionId: row.sessionId, messages: [] }),
    "sessions.list": () => sessionsResult([row], row.snapshotAt ?? 0),
    "chat.send": { runId: "accepted-input", status: "started" },
  });
  const client = createTestGatewayClient(request);
  const { gateway, emitEvent } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const host = makeChatHost({
    client,
    sessions,
    sessionKey: paused.key,
    currentSessionId: paused.sessionId,
    chatMessage: "Keep this draft",
    sessionsResult: sessionsResult([row], row.snapshotAt ?? 0),
  });
  const outbox = { sessionKey: paused.key, agentId: "main" };
  for (const id of ["first", "second"]) {
    expect(
      admitQueuedMessageForSession(
        host,
        { scope: outbox, awaitingDefaults: false },
        {
          id,
          text: `Retained ${id} input`,
          createdAt: 1,
          sessionKey: paused.key,
          agentId: "main",
          sendState: "waiting-idle",
          sendRunId: `unsent-${id}`,
        },
      ),
    ).toBe(true);
  }
  await handleSendChat(host);
  await flushChatQueueForEvent(host);
  await retryQueuedChatMessage(host, "first");
  expect(host.chatMessage).toBe("Keep this draft");
  expect(requestCalls(request, "chat.send")).toHaveLength(0);
  expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
    expect.objectContaining({
      id: "first",
      text: "Retained first input",
      sendState: "held",
    }),
    expect.objectContaining({
      id: "second",
      text: "Retained second input",
      sendState: "held",
    }),
  ]);

  row = { ...paused, providerReview: undefined, updatedAt: 11, snapshotAt: 11 };
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: paused.key,
      agentId: "main",
      session: { ...row, providerReview: null },
    },
  });
  expect(chatProviderReviewRow(host)?.providerReview).toBeUndefined();
  await flushChatQueueForEvent(host);
  expect(requestCalls(request, "chat.send")).toHaveLength(0);
  await retryQueuedChatMessage(host, "first");
  expect(requestCalls(request, "chat.send")).toEqual([
    expect.arrayContaining([
      "chat.send",
      expect.objectContaining({ message: "Retained first input" }),
    ]),
  ]);
  expect(listStoredChatOutboxes(host)[0]?.queue).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "second",
        text: "Retained second input",
        sendState: "held",
      }),
    ]),
  );
});

it("keeps provider review receipts through partial events and rejects a stale read after authoritative clearing", async () => {
  const request = makeRequestMock({ "sessions.list": sessionsResult([paused], 10) });
  const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const readBeforeClear = sessions.captureReconcile();
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: paused.key,
      agentId: "main",
      session: {
        key: paused.key,
        sessionId: paused.sessionId,
        updatedAt: 11,
        snapshotAt: 11,
        label: "Renamed",
      },
    },
  });
  expect(sessions.state.result?.sessions[0]?.providerReview).toEqual(paused.providerReview);
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: paused.key,
      agentId: "main",
      session: {
        key: paused.key,
        sessionId: paused.sessionId,
        updatedAt: 12,
        snapshotAt: 12,
        providerReview: null,
      },
    },
  });
  readBeforeClear(paused);
  expect(sessions.state.result?.sessions[0]?.providerReview).toBeUndefined();
});

it("keeps a paused queue input held when its earlier settings wait finishes after continuation", async () => {
  const settings = createDeferred<boolean>();
  const waiting = createDeferred();
  const host = makeChatHost({
    requestHandlers: { "chat.send": { status: "started" } },
    sessionKey: paused.key,
    currentSessionId: paused.sessionId,
    sessionsResult: sessionsResult([{ ...paused, providerReview: undefined }], 10),
  });
  const item = {
    id: "settings-delayed-input",
    text: "Keep this queued input",
    createdAt: 1,
    sessionKey: paused.key,
    agentId: "main",
    sendRunId: "not-dispatched",
    sendState: "waiting-idle" as const,
  };
  expect(
    admitQueuedMessageForSession(
      host,
      { scope: { sessionKey: paused.key, agentId: "main" }, awaitingDefaults: false },
      item,
    ),
  ).toBe(true);
  host.requestUpdate = () => {
    if (host.chatQueue[0]?.sendState === "waiting-model") {
      waiting.resolve();
    }
  };
  const delivery = deliverChatQueueItem(host, item, { pendingSettings: settings.promise });
  await waiting.promise;
  holdProviderReviewQueuedInputs(host);
  settings.resolve(true);
  await delivery;
  await flushChatQueueForEvent(host);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
  expect(host.chatQueue[0]).toMatchObject({ text: item.text, sendState: "held" });
  expect(host.chatQueue[0]?.sendRunId).toBe(item.sendRunId);
});

it.each(["lost-ack", "accepted-unconsumed"] as const)(
  "holds %s input across pause clearing, reload, and positive interrupted custody until explicit retry",
  async (outcome) => {
    let row: GatewaySessionRow = {
      ...paused,
      providerReview: undefined,
      updatedAt: 9,
      snapshotAt: 9,
    };
    let attemptedRunId: string | undefined;
    let attempts = 0;
    const request = makeRequestMock({
      "sessions.list": () => sessionsResult([row], row.snapshotAt ?? 0),
      "chat.history": () => ({
        messages: [],
        sessionId: row.sessionId,
        sessionInfo: { ...row, hasActiveRun: false, status: "done" },
        pendingInputs: {
          items: attemptedRunId
            ? [
                {
                  id: "accepted-input",
                  runId: attemptedRunId,
                  acceptedAt: 1,
                  state: "interrupted",
                  message: { role: "user", content: "Keep this delivery identity" },
                },
              ]
            : [],
          total: attemptedRunId ? 1 : 0,
        },
        inputReceipts: attemptedRunId ? [{ runId: attemptedRunId, state: "pending" }] : [],
      }),
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
    const client = createTestGatewayClient(request);
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const host = makeChatHost({
      client,
      sessions,
      sessionKey: row.key,
      currentSessionId: row.sessionId,
      sessionsResult: sessionsResult([row], 9),
      chatMessage: "Keep this delivery identity",
    });
    await handleSendChat(host);
    expect(attempts).toBe(1);
    const attempted = host.chatQueue[0];
    expect(attempted).toMatchObject({
      sendAttempts: 1,
      sendState: outcome === "lost-ack" ? "waiting-reconnect" : "sending",
      sendRunId: attemptedRunId,
    });
    row = paused;
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: row.key, agentId: "main", session: row },
    });
    expect(chatProviderReviewRow(host)?.providerReview).toEqual(paused.providerReview);
    await flushChatQueueForEvent(host);
    expect(host.chatQueue[0]).toMatchObject({
      id: attempted?.id,
      text: attempted?.text,
      createdAt: attempted?.createdAt,
      sessionKey: attempted?.sessionKey,
      sendState: "held",
      sendAttempts: 1,
      sendRunId: attemptedRunId,
    });

    row = { ...paused, providerReview: undefined, updatedAt: 11, snapshotAt: 11 };
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: row.key, agentId: "main", session: { ...row, providerReview: null } },
    });
    await loadChatHistory(host, { deferBranches: true });
    await flushChatQueueForEvent(host);
    expect(attempts).toBe(1);
    reloadChatDocumentStorage([]);
    const reloaded = makeChatHost({
      client: createTestGatewayClient(request),
      sessionKey: row.key,
      currentSessionId: row.sessionId,
      sessionsResult: sessionsResult([row], 11),
    });
    expect(restoreChatComposerState(reloaded)).toBe(true);
    expect(reloaded.chatQueue[0]).toMatchObject({
      sendState: "held",
      sendAttempts: 1,
      sendRunId: attemptedRunId,
    });
    await loadChatHistory(reloaded, { deferBranches: true });
    await flushChatQueueForEvent(reloaded);
    expect(attempts).toBe(1);
    expect(reloaded.chatQueue[0]).toMatchObject({
      sendState: "held",
      sendAttempts: 1,
      sendRunId: attemptedRunId,
      sessionId: row.sessionId,
    });
    await retryQueuedChatMessage(reloaded, attempted!.id);
    expect(attempts).toBe(2);
    const sent = requestCalls(request, "chat.send");
    expect(sent[1]?.[1]).toMatchObject({
      idempotencyKey: requireRecord(sent[0]?.[1], "original send").idempotencyKey,
      message: "Keep this delivery identity",
    });
    expect(listStoredChatOutboxes(reloaded)).toEqual([]);
  },
);

it.each(["consumed", "pending", "disconnected"] as const)(
  "preserves in-flight delivery identity when its late outcome is %s after review clears",
  async (outcome) => {
    const started = createDeferred();
    const acknowledgment = createDeferred<unknown>();
    const initial = { ...paused, providerReview: undefined, updatedAt: 9, snapshotAt: 9 };
    const request = makeRequestMock({
      "sessions.list": () => sessionsResult([initial], 9),
      "chat.send": () => {
        started.resolve();
        return acknowledgment.promise;
      },
    });
    const client = createTestGatewayClient(request);
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const host = makeChatHost({
      client,
      sessions,
      sessionKey: paused.key,
      currentSessionId: paused.sessionId,
      sessionsResult: sessionsResult([initial], 9),
      chatMessage: "Already in flight",
    });
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
    const continued = { ...paused, providerReview: undefined, updatedAt: 11, snapshotAt: 11 };
    host.sessionsResult = sessionsResult([continued], 11);
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: continued.key,
        agentId: "main",
        session: { ...continued, providerReview: null },
      },
    });
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
    if (outcome === "consumed") {
      expect(listStoredChatOutboxes(host)).toEqual([]);
    } else {
      expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
        expect.objectContaining({
          text: inFlight?.text,
          sendRunId: inFlight?.sendRunId,
          sendAttempts: 1,
          sendState: "held",
        }),
      ]);
    }
  },
);

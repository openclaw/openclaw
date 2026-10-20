/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { listChatOutboxAttention } from "./chat-outbox-owner.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { UNCONFIRMED_CHAT_SEND_ERROR } from "./chat-send-support.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

const sessionKey = "agent:main:restart-input";
const sessionId = "restart-input-session";
const item: ChatQueueItem = {
  id: "browser-input",
  sendRunId: "accepted-input",
  sessionKey,
  text: "Continue after the update",
  createdAt: 100,
  sendAttempts: 1,
  sendState: "waiting-reconnect",
};
function pending(state: "queued" | "interrupted" | "cancelled"): ChatPendingInputsPage {
  return {
    total: 1,
    items: [
      {
        id: "durable-input",
        runId: item.sendRunId,
        acceptedAt: 100,
        state,
        message: { role: "user", content: item.text },
      },
    ],
  };
}

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("accepted input restart handoff", () => {
  it("keeps local commands behind accepted input until transcript consumption", async () => {
    let consumed = false;
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": () => ({
          sessionId,
          messages: [],
          pendingInputs: consumed ? { items: [], total: 0 } : pending("interrupted"),
          inputReceipts: [
            consumed
              ? { runId: item.sendRunId, state: "consumed", consumedByEventId: "saved-input" }
              : { runId: item.sendRunId, state: "pending" },
          ],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        }),
        "sessions.compact": { ok: true, compacted: true },
      },
    });
    for (const queued of [
      item,
      {
        id: "queued-compact",
        text: "/compact",
        localCommandName: "compact",
        createdAt: 200,
        sendAttempts: 0,
        sendState: "waiting-reconnect" as const,
      },
    ]) {
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
          ...queued,
          sessionId,
        }),
      ).toBe(true);
    }
    await resumeStoredChatOutboxes(host);
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.compact")).toEqual([]);
    consumed = true;
    await resumeStoredChatOutboxes(host);
    await resumeStoredChatOutboxes(host);
    expect(
      host.request.mock.calls.filter(([method]) => method === "sessions.compact"),
    ).toHaveLength(1);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it("retains expired server custody without blocking a later queued input", async () => {
    let known = false;
    const successor = {
      ...item,
      id: "later-browser-input",
      sendRunId: "later-input",
      text: "A new independent input",
      createdAt: 200,
      sendAttempts: 0,
      sendState: "waiting-reconnect" as const,
    };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": () => ({
          sessionId,
          messages: [],
          pendingInputs: known ? pending("interrupted") : { items: [], total: 0 },
          inputReceipts: known ? [{ runId: item.sendRunId, state: "pending" }] : [],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        }),
        "chat.send": { runId: successor.sendRunId, status: "started", messageSeq: 10 },
      },
    });
    for (const queued of [item, successor]) {
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
          ...queued,
          sessionId,
        }),
      ).toBe(true);
    }
    // Without a fresh receipt, an uncertain predecessor remains a FIFO barrier.
    await resumeStoredChatOutboxes(host);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    known = true;
    await resumeStoredChatOutboxes(host);
    await resumeStoredChatOutboxes(host);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([
      [
        "chat.send",
        expect.objectContaining({ idempotencyKey: successor.sendRunId }),
        expect.anything(),
      ],
    ]);
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
      expect.objectContaining({
        id: item.id,
        text: item.text,
        sessionId,
        sendRunId: item.sendRunId,
        sendAttempts: 1,
      }),
    ]);
  });

  it.each(
    (["foreground history", "background reconciliation"] as const).flatMap((delivery) =>
      (["consumed", "cancelled"] as const).map((outcome) => ({ delivery, outcome })),
    ),
  )(
    "retains exact custody via $delivery until its off-page $outcome receipt settles",
    async ({ delivery, outcome }) => {
      let settled = false;
      const visible = delivery === "foreground history";
      const host = makeChatHost({
        sessionKey: visible ? sessionKey : "agent:main:another-conversation",
        currentSessionId: visible ? sessionId : "another-physical-session",
        requestHandlers: {
          "chat.history": () => ({
            sessionId,
            messages: [],
            pendingInputs: settled ? { items: [], total: 21, nextBefore: 21 } : pending("queued"),
            inputReceipts: settled
              ? [
                  outcome === "cancelled"
                    ? { runId: item.sendRunId, state: "pending", cancelled: true }
                    : {
                        runId: item.sendRunId,
                        state: "consumed",
                        consumedByEventId: "canonical-input",
                      },
                ]
              : [{ runId: item.sendRunId, state: "pending" }],
            sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
          }),
        },
      });
      const uncertain = {
        ...item,
        sessionId,
        sendState: "unconfirmed" as const,
        sendError: UNCONFIRMED_CHAT_SEND_ERROR,
      };
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), uncertain),
      ).toBe(true);
      expect(listChatOutboxAttention(host)).toHaveLength(1);
      if (visible) {
        await loadChatHistory(host);
      } else {
        await resumeStoredChatOutboxes(host);
      }
      expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
        id: item.id,
        text: item.text,
        sessionId,
        sendRunId: item.sendRunId,
        sendAttempts: 1,
        sendState: "waiting-idle",
      });
      expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendError).toBeUndefined();
      expect(listChatOutboxAttention(host)).toEqual([]);
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      settled = true;
      if (visible) {
        await loadChatHistory(host);
      } else {
        await resumeStoredChatOutboxes(host);
      }
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(listChatOutboxAttention(host)).toEqual([]);
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    },
  );

  it.each(["unknown later", "storage unavailable"] as const)(
    "retains the same attempted payload and never blindly replays it when %s",
    async (condition) => {
      let known = true;
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": () => ({
            sessionId,
            messages: [],
            pendingInputs: known ? pending("queued") : { items: [], total: 0 },
            inputReceipts: known ? [{ runId: item.sendRunId, state: "pending" }] : [],
            sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
          }),
        },
      });
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
          ...item,
          sessionId,
          sendState: "unconfirmed",
          sendError: UNCONFIRMED_CHAT_SEND_ERROR,
        }),
      ).toBe(true);
      if (condition === "storage unavailable") {
        vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
          throw new Error("storage unavailable");
        });
      }
      await resumeStoredChatOutboxes(host);
      if (condition === "unknown later") {
        expect(listChatOutboxAttention(host)).toEqual([]);
        known = false;
        await resumeStoredChatOutboxes(host);
      }
      expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
        id: item.id,
        text: item.text,
        sendRunId: item.sendRunId,
        sendAttempts: 1,
        sendState: "unconfirmed",
      });
      expect(listChatOutboxAttention(host)).toHaveLength(1);
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    },
  );

  it.each([
    { queueMode: undefined, status: "running", hasActiveRun: false },
    { queueMode: "followup", status: "running", hasActiveRun: false },
    { queueMode: "collect", status: "queued", hasActiveRun: false },
    { queueMode: "followup", status: "running", hasActiveRun: true },
    { queueMode: "steer", status: "running", hasActiveRun: true },
    { queueMode: "interrupt", status: "running", hasActiveRun: true },
  ] as const)(
    "leaves server recovery in charge for $queueMode ($status, active: $hasActiveRun)",
    async ({ queueMode, status, hasActiveRun }) => {
      let recoveryFinished = false;
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": () => ({
            sessionId,
            messages: [],
            pendingInputs: recoveryFinished ? { items: [], total: 0 } : pending("interrupted"),
            inputReceipts: [
              {
                runId: item.sendRunId,
                state: recoveryFinished ? "consumed" : "pending",
                ...(recoveryFinished ? { consumedByEventId: "server-recovered-input" } : {}),
              },
            ],
            sessionInfo: {
              key: sessionKey,
              sessionId,
              status: recoveryFinished ? "done" : status,
              hasActiveRun: recoveryFinished ? false : hasActiveRun,
            },
          }),
          "chat.send": { runId: item.sendRunId, status: "started", messageSeq: 10 },
        },
      });
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
          ...item,
          sessionId,
          ...(queueMode ? { queueMode } : {}),
        }),
      ).toBe(true);
      await resumeStoredChatOutboxes(host);
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
      expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe(item.sendRunId);
      recoveryFinished = true;
      await resumeStoredChatOutboxes(host);
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
      expect(listStoredChatOutboxes(host)).toEqual([]);
    },
  );

  it("does not retire or resend an input from a replaced physical session", async () => {
    const replacementSessionId = "replacement-session";
    const host = makeChatHost({
      sessionKey,
      currentSessionId: replacementSessionId,
      requestHandlers: {
        "chat.history": {
          sessionId: replacementSessionId,
          messages: [
            {
              role: "user",
              content: "A different source",
              __openclaw: {
                id: "replacement-input",
                seq: 1,
                idempotencyKey: `${item.sendRunId}:user`,
              },
            },
          ],
          pendingInputs: { items: [], total: 0 },
          sessionInfo: {
            key: sessionKey,
            sessionId: replacementSessionId,
            status: "done",
            hasActiveRun: false,
          },
        },
      },
    });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
        ...item,
        sessionId,
      }),
    ).toBe(true);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sessionId).toBe(sessionId);
    await resumeStoredChatOutboxes(host);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      sessionId,
      sendState: "unconfirmed",
    });
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });
  it("reconciles interrupted custody behind a newer page without resending", async () => {
    const older = pending("interrupted");
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": (params: { pendingBefore?: number }) => ({
          sessionId,
          messages: [],
          pendingInputs:
            params.pendingBefore === 21
              ? older
              : {
                  total: 21,
                  items: Array.from({ length: 20 }, (_, index) => ({
                    id: `newer-${index}`,
                    runId: `newer-run-${index}`,
                    acceptedAt: 200 + index,
                    state: "queued",
                    message: { role: "user", content: `Newer input ${index}` },
                  })),
                  nextBefore: 21,
                },
          inputReceipts: [{ runId: item.sendRunId, state: "pending" }],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        }),
        "chat.send": { runId: item.sendRunId, status: "started" },
      },
    });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
        ...item,
        sessionId,
      }),
    ).toBe(true);
    await resumeStoredChatOutboxes(host);
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 21 }),
      { timeoutMs: 30_000 },
    );
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  });
  it("retains browser custody until transcript consumption, then retires it", () => {
    const host = makeChatHost({ sessionKey, currentSessionId: sessionId, requestHandlers: {} });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), item),
    ).toBe(true);

    applyChatPendingInputs(host, pending("queued"));
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe(item.sendRunId);
    applyChatPendingInputs(host, pending("interrupted"));
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe(item.sendRunId);
    applyChatPendingInputs(
      host,
      { items: [], total: 0 },
      {
        receipts: [{ runId: item.sendRunId!, state: "consumed", consumedByEventId: "aggregate" }],
      },
    );
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it.each(["interrupted", "queued", "cancelled", "unknown"] as const)(
    "does not automatically resend accepted or uncertain input after reconnect (%s)",
    async (disposition) => {
      const page = disposition === "unknown" ? { items: [], total: 0 } : pending(disposition);
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": {
            sessionId,
            messages: [],
            pendingInputs: page,
            inputReceipts:
              disposition === "unknown" ? [] : [{ runId: item.sendRunId, state: "pending" }],
            sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
          },
          "chat.send": { runId: item.sendRunId, status: "started" },
        },
      });
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), item),
      ).toBe(true);
      await resumeStoredChatOutboxes(host);
      const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
      expect(sends).toHaveLength(0);
    },
  );
});

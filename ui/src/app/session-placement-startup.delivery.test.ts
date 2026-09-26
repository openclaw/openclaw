import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "../pages/chat/chat-pending-inputs.ts";
import { buildChatItems } from "../pages/chat/chat-thread-build.ts";
import { admitChatSubmission, reduceChatSessionProjection } from "../pages/chat/history-merge.ts";
import {
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";

describe("application placement delivery recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["rpc", "error", "timeout"] as const)(
    "delivery recovery rotates a cached %s rejection only on explicit Retry",
    async (failure) => {
      const rejection = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "send rejected",
      });
      const request = vi.fn((method: string, payload?: Record<string, unknown>) => {
        if (method === "sessions.describe") {
          return Promise.resolve({
            session: { placement: createStartupPlacement("reclaimed", 3) },
          });
        }
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: createStartupPlacement("active", 2) });
        }
        if (method === "sessions.reclaim") {
          return Promise.resolve({ ok: true });
        }
        if (method === "sessions.send") {
          if (payload?.idempotencyKey === "message-stable") {
            return failure === "rpc"
              ? Promise.reject(rejection)
              : Promise.resolve({ runId: "message-stable", status: failure });
          }
          return Promise.resolve({ runId: payload?.idempotencyKey, status: "started" });
        }
        throw new Error(`unexpected method ${method}`);
      });
      const { startup, input, chatSubmissions, client } = createPlacementStartupHarness(request);
      input.recovery = {
        ...input.recovery,
        target: { kind: "profile", profileId: "aws", machineClass: "fast" },
        attachments: [{ type: "file", mimeType: "text/plain", content: "SGk=" }],
      };
      writeSessionPlacementRecovery(input.recovery);
      startup.start(input);
      try {
        await vi.waitFor(() =>
          expect(startup.get(input.recovery.sessionKey)?.phase).toBe("failed"),
        );
        expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)).toBeNull();
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toMatchObject({ phase: "paused", reason: "rejected", messageId: "message-stable" });
        startup.retry(input.recovery.sessionKey);
        startup.retry(input.recovery.sessionKey);
        const replacement = readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        );
        expect(replacement?.messageId).not.toBe(input.recovery.messageId);
        await vi.waitFor(() => expect(startup.get(input.recovery.sessionKey)).toBeNull());
        const sends = request.mock.calls.filter(([method]) => method === "sessions.send");
        expect(sends).toHaveLength(2);
        expect(sends[1]?.[1]).toMatchObject({
          key: input.recovery.sessionKey,
          message: input.recovery.message,
          attachments: input.recovery.attachments,
          idempotencyKey: expect.any(String),
        });
        expect(sends[1]?.[1]?.idempotencyKey).not.toBe("message-stable");
        expect(
          request.mock.calls
            .filter(([method]) => method === "sessions.dispatch")
            .map(([, payload]) => payload),
        ).toEqual(
          [1, 2].map(() => ({
            key: input.recovery.sessionKey,
            agentId: input.recovery.agentId,
            profileId: "aws",
            machineClass: "fast",
          })),
        );
        expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)?.pendingRunId).toBe(
          sends[1]?.[1]?.idempotencyKey,
        );
        // Even though Retry rotates the rejected send's message id, the
        // accepted message keeps the original prompt timestamp.
        expect(
          chatSubmissions.readInitial(input.recovery.sessionKey, client)?.message?.timestamp,
        ).toBe(input.createdAt);
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["active", "local", "failed", "reclaimed"])(
    "delivery recovery checks uncertain sending without mutating %s placement",
    async (state) => {
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          return Promise.resolve({ messages: [] });
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { placement: createStartupPlacement(state, 2) } });
        }
        return Promise.resolve({ status: "started" });
      });
      const { startup, input, dependencies } = createPlacementStartupHarness(request);
      const attachments = [
        { type: "file", mimeType: "text/plain", fileName: "note.txt", content: "SGk=" },
      ];
      input.recovery = { ...input.recovery, phase: "sending", attachments };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      try {
        await vi.waitFor(() =>
          expect(startup.get(input.recovery.sessionKey)).toMatchObject({
            phase: "failed",
            action: "check-delivery",
            initialTurn: {
              text: input.recovery.message,
              sendState: "unconfirmed",
              attachments: [{ dataUrl: "data:text/plain;base64,SGk=" }],
            },
          }),
        );
        startup.retry(input.recovery.sessionKey);
        startup.retry(input.recovery.sessionKey);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        expect(request.mock.calls.every(([method]) => method === "chat.history")).toBe(true);
        expect(request).toHaveBeenCalledWith(
          "chat.history",
          expect.objectContaining({ sessionKey: input.recovery.sessionKey, limit: 1000 }),
        );
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toMatchObject({
          phase: "paused",
          reason: "unconfirmed",
          messageId: input.recovery.messageId,
          attachments,
        });
        startup.dispose();
        const reloaded = createApplicationPlacementStartup(dependencies);
        reloaded.resumeRecovery();
        try {
          await vi.waitFor(() =>
            expect(reloaded.get(input.recovery.sessionKey)).toMatchObject({
              action: "check-delivery",
              initialTurn: { text: input.recovery.message, sendRunId: input.recovery.messageId },
            }),
          );
          expect(request).toHaveBeenCalledTimes(2);
        } finally {
          reloaded.dispose();
        }
      } finally {
        startup.dispose();
      }
    },
  );

  it.each([
    "exact-user",
    "pending-queued",
    "pending-interrupted",
    "pending-cancelled",
    "retained-outside-page",
    "consumed",
    "assistant",
    "same-text",
    "unavailable",
  ])("delivery recovery settles only authoritative input custody (%s)", async (evidence) => {
    const acceptedInput =
      evidence.startsWith("pending-") ||
      evidence === "retained-outside-page" ||
      evidence === "consumed";
    const delivered = evidence === "exact-user" || acceptedInput;
    const request = vi.fn((method: string, payload?: Record<string, unknown>) => {
      if (method === "chat.history") {
        if (evidence === "unavailable") {
          return Promise.reject(new Error("history unavailable"));
        }
        return Promise.resolve({
          sessionId: "physical-cloud-session",
          messages: acceptedInput
            ? []
            : [
                {
                  role: evidence === "assistant" ? "assistant" : "user",
                  content: [{ type: "text", text: "fix the cloud task" }],
                  __openclaw: {
                    idempotencyKey: evidence === "same-text" ? "other:user" : "message-stable:user",
                  },
                },
              ],
          pendingInputs: {
            items: evidence.startsWith("pending-")
              ? [
                  {
                    id: "accepted-initial-input",
                    runId: "message-stable",
                    state: evidence.slice("pending-".length),
                    acceptedAt: 1_000,
                    message: {
                      role: "user",
                      content: "fix the cloud task",
                      __openclaw: { id: "pending:accepted-initial-input" },
                    },
                  },
                ]
              : evidence === "retained-outside-page"
                ? Array.from({ length: 20 }, (_, index) => ({
                    id: `newer-${index}`,
                    runId: `newer-${index}`,
                    state: "interrupted",
                    acceptedAt: 1_001 + index,
                    message: { role: "user", content: `newer-${index}` },
                  }))
                : [],
            total:
              evidence === "retained-outside-page" ? 21 : evidence.startsWith("pending-") ? 1 : 0,
          },
          ...(acceptedInput &&
          Array.isArray(payload?.inputRunIds) &&
          payload.inputRunIds.includes("message-stable")
            ? {
                inputReceipts: [
                  evidence === "consumed"
                    ? {
                        runId: "message-stable",
                        state: "consumed",
                        consumedByEventId: "aggregate-user",
                      }
                    : { runId: "message-stable", state: "pending" },
                ],
              }
            : {}),
        });
      }
      if (method === "sessions.describe") {
        return Promise.resolve({ session: { placement: createStartupPlacement("active", 1) } });
      }
      return Promise.resolve({ status: "started" });
    });
    const { startup, input, chatSubmissions, client } = createPlacementStartupHarness(request);
    input.recovery = { ...input.recovery, phase: "sending" };
    writeSessionPlacementRecovery(input.recovery);
    startup.resumeRecovery();
    try {
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
      );
      await vi.waitFor(() => {
        if (delivered) {
          expect(startup.get(input.recovery.sessionKey)).toBeNull();
          expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false);
          const handoff = chatSubmissions.readInitial(input.recovery.sessionKey, client);
          expect(handoff?.pendingRunId).toBe(input.recovery.messageId);
        } else {
          expect(startup.get(input.recovery.sessionKey)).toMatchObject({
            phase: "failed",
            action: "check-delivery",
            initialTurn: { text: input.recovery.message },
          });
        }
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
      const stored = readSessionPlacementRecovery(
        input.recovery.gatewayUrl,
        input.recovery.recoveryScope,
        input.recovery.sessionKey,
      );
      if (delivered) {
        expect(stored).toBeNull();
      } else {
        expect(stored).toMatchObject({
          phase: "paused",
          reason: "unconfirmed",
          messageId: input.recovery.messageId,
        });
      }
    } finally {
      startup.dispose();
    }
  });

  it.each([
    { order: "pane-first", receipt: "pending" },
    { order: "recovery-first", receipt: "pending" },
    { order: "recovery-first", receipt: "consumed" },
  ] as const)(
    "keeps exactly one initial prompt when $receipt custody arrives $order",
    async ({ order, receipt }) => {
      const history = createDeferred<unknown>();
      const request = vi.fn(() => history.promise);
      const { startup, input, gateway, chatSubmissions } = createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      const pane = makeChatHost({
        sessionKey: input.recovery.sessionKey,
        currentSessionId: "physical-cloud-session",
        client: gateway.snapshot.client,
        chatSubmissions,
      });
      const page = {
        items: [
          {
            id: "accepted-initial-input",
            runId: input.recovery.messageId,
            state: "queued" as const,
            acceptedAt: input.createdAt,
            message: {
              role: "user",
              content: [{ type: "text", text: input.recovery.message }],
              timestamp: input.createdAt,
              __openclaw: { id: "pending:accepted-initial-input" },
            },
          },
        ],
        total: 1,
      };
      const visibleMessages = () => {
        const initialTurn = startup.get(pane.sessionKey)?.initialTurn;
        return buildChatItems({
          paneId: `startup-custody-${order}`,
          sessionKey: pane.sessionKey,
          messages: pane.chatMessages,
          pendingInputs: getChatPendingInputs(pane)?.page.items,
          queue: initialTurn ? [initialTurn] : [],
          initialTurnId: initialTurn?.id,
          toolMessages: [],
          streamSegments: [],
          stream: null,
          streamStartedAt: null,
          showToolCalls: true,
        }).flatMap((item) =>
          item.kind === "group" && item.role === "user"
            ? item.messages.map((entry) => entry.message)
            : [],
        );
      };
      const publications: unknown[][] = [];
      const stop = startup.subscribe(() => {
        admitChatSubmission(pane, getChatPendingInputs(pane)?.page.items);
        publications.push(visibleMessages());
      });
      try {
        startup.resumeRecovery();
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        expect(visibleMessages()).toHaveLength(1);
        publications.length = 0;
        if (order === "pane-first") {
          applyChatPendingInputs(pane, page);
          expect(visibleMessages()).toHaveLength(1);
        }
        history.resolve({
          sessionId: pane.currentSessionId,
          messages: [],
          pendingInputs: receipt === "pending" ? page : { items: [], total: 0 },
          inputReceipts: [
            {
              runId: input.recovery.messageId,
              state: receipt,
              ...(receipt === "consumed" ? { consumedByEventId: "aggregate-input" } : {}),
            },
          ],
        });
        await vi.waitFor(() => expect(startup.get(pane.sessionKey)).toBeNull());
        expect(visibleMessages()).toHaveLength(1);
        expect(publications.length).toBeGreaterThan(0);
        for (const messages of publications) {
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatchObject({
            content: [{ type: "text", text: input.recovery.message }],
          });
        }
        if (receipt === "consumed") {
          const aggregate = {
            role: "user",
            content: [{ type: "text", text: input.recovery.message }],
            __openclaw: {
              id: "aggregate-input",
              seq: 1,
              idempotencyKey: "followup-collect:session:batch",
            },
          };
          // The pane requested this snapshot before the handoff supplied inputRunIds.
          reduceChatSessionProjection(pane, { type: "snapshotLoaded", messages: [aggregate] });
          applyChatPendingInputs(pane, { items: [], total: 0 });
          expect(visibleMessages()).toEqual([aggregate]);
        } else {
          applyChatPendingInputs(pane, page);
          expect(visibleMessages()).toEqual(page.items.map((item) => item.message));
          expect(pane.chatMessages).toEqual([]);
        }
        expect(request).toHaveBeenCalledOnce();
      } finally {
        stop();
        startup.dispose();
      }
    },
  );

  it.each(["message", "credential"])(
    "delivery recovery fences a stale observation after %s ownership changes",
    async (changed) => {
      const history = createDeferred<{ messages: unknown[] }>();
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          return history.promise;
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { placement: createStartupPlacement("active", 1) } });
        }
        return Promise.resolve({ status: "started" });
      });
      const { startup, input, client, chatSubmissions } = createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      try {
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
        );
        const retained =
          changed === "message"
            ? { ...input.recovery, messageId: "new-owner", message: "new submission" }
            : input.recovery;
        writeSessionPlacementRecovery(retained);
        if (changed === "credential") {
          client.recoveryScope = "principal-b";
        }
        expect(startup.get(input.recovery.sessionKey)).toBeNull();
        history.resolve({
          messages: [{ role: "user", __openclaw: { idempotencyKey: "message-stable:user" } }],
        });
        await flushStartupMicrotasks();
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toEqual(retained);
        expect(chatSubmissions.readInitial(input.recovery.sessionKey, client)).toBeNull();
        expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
      } finally {
        startup.dispose();
      }
    },
  );
});

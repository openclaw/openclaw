// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import {
  flushChatQueueForEvent,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { restoreChatComposerState } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { beginQueuedMessageEdit, updateQueuedMessageEdit } from "./queued-message-edit.ts";

useChatSendBrowserFixture();

describe("Auto send overlay", () => {
  it.each([false, true])(
    "renews a failed Auto retry only with proven no custody (%s)",
    async (proven) => {
      const original = {
        id: "auto-failed",
        text: "Preserve the full input",
        createdAt: 1,
        deliveryPolicy: "auto" as const,
        queueMode: "followup" as const,
        sendState: "failed" as const,
        sendRunId: "failed-auto-run",
        sendRejectedBeforeCustody: proven,
        sessionKey: "agent:main:main",
        agentId: "main",
      };
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatQueue: [original],
        sessionKey: original.sessionKey,
        settings: { chatAutoSteer: false },
        isAutoSteerAvailable: () => false,
      });
      expect(
        admitQueuedMessageForSession(
          host,
          captureChatOutboxAdmission(host, host.sessionKey, original.agentId),
          original,
        ),
      ).toBe(true);
      await retryQueuedChatMessage(host, original.id);
      const payload = findChatSendPayload(host);
      expect(payload).toMatchObject({
        message: original.text,
        deliveryPolicy: "auto",
        queueMode: "followup",
      });
      if (proven) {
        expect(payload.idempotencyKey).not.toBe(original.sendRunId);
      } else {
        expect(payload.idempotencyKey).toBe(original.sendRunId);
      }
    },
  );
  // Historical v4 wire shape from d9d8f0829d87 (before Auto): no new-row
  // writer/admission helper manufactures these upgrade inputs.
  it.each([undefined, "steer", "followup"] as const)(
    "restores and retries a pre-Auto %s outbox without inferring Auto",
    async (queueMode) => {
      const gatewayUrl = "ws://historical-outbox.test";
      const storageKey = "openclaw.control.chatComposer.v4:ws%3A%2F%2Fhistorical-outbox.test";
      const modeField = queueMode ? `,"queueMode":"${queueMode}"` : "";
      const oldBytes = `{"version":4,"gatewayOwner":"ws://historical-outbox.test","sessions":{"agent:main:main\\u0000agent:main":{"draft":"Unsent historical draft","draftRevision":7,"updatedAt":1700000000000,"queue":[{"id":"old-input","sessionKey":"agent:main:main","agentId":"main","text":"Keep commas, quotes and tabs.","createdAt":1700000000000,"sendRunId":"old-run","sendState":"sending","sendAttempts":2,"sender":{"id":"historical-human","name":"Historical human","username":"historical"}${modeField}}]}},"recovery":{}}`;
      sessionStorage.setItem(storageKey, oldBytes);
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": { status: "started" },
          "chat.history": {
            messages: [],
            sessionInfo: {
              key: "agent:main:main",
              sessionId: "historical-session",
              kind: "direct",
              updatedAt: 1700000000000,
              hasActiveRun: false,
              status: "done",
            },
          },
        },
        sessionKey: "agent:main:main",
        agentsList: { defaultId: "main", mainKey: "main" },
        settings: { gatewayUrl, chatAutoSteer: true, chatFollowUpMode: "steer" },
        isAutoSteerAvailable: () => true,
      });
      expect(restoreChatComposerState(host)).toBe(true);
      expect(sessionStorage.getItem(storageKey)).toBe(oldBytes);
      expect(host.chatMessage).toBe("Unsent historical draft");
      expect(host.chatQueue).toHaveLength(1);
      expect(host.chatQueue[0]).toMatchObject({
        id: "old-input",
        text: "Keep commas, quotes and tabs.",
        sendRunId: "old-run",
        sendState: "waiting-reconnect",
        sendAttempts: 2,
        sender: { id: "historical-human", name: "Historical human", username: "historical" },
      });
      expect(host.chatQueue[0]?.queueMode).toBe(queueMode);
      expect(host.chatQueue[0]?.deliveryPolicy).toBeUndefined();
      await retryQueuedChatMessage(host, "old-input");
      const payload = findChatSendPayload(host);
      expect(payload).toMatchObject({
        message: "Keep commas, quotes and tabs.",
        idempotencyKey: "old-run",
      });
      expect(payload.queueMode).toBe(queueMode);
      expect(payload).not.toHaveProperty("deliveryPolicy");
    },
  );
  it("retains Auto and its server baseline through a queued edit after Auto is turned off", async () => {
    const original = {
      id: "edit-auto",
      text: "Keep keyboard behavior",
      createdAt: 1,
      deliveryPolicy: "auto" as const,
      sendState: "waiting-idle" as const,
      sendRunId: "original-input",
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeChatHost({
      requestHandlers: { "chat.send": { status: "ok" } },
      chatQueue: [original],
      sessionKey: original.sessionKey,
      settings: { chatAutoSteer: false, chatFollowUpMode: "queue" },
      isAutoSteerAvailable: () => false,
    });
    expect(
      admitQueuedMessageForSession(
        host,
        captureChatOutboxAdmission(host, host.sessionKey, original.agentId),
        original,
      ),
    ).toBe(true);
    expect(beginQueuedMessageEdit(host, original.id)).toBe("started");
    expect(updateQueuedMessageEdit(host, "Keep all keyboard shortcuts")).toBe(true);
    await handleSendChat(host, "Keep all keyboard shortcuts", {
      resumeQueuedMessageEditId: original.id,
    });
    const payload = findChatSendPayload(host);
    expect(payload.deliveryPolicy).toBe("auto");
    expect(payload.queueMode).toBeUndefined();
    expect(payload.message).toBe("Keep all keyboard shortcuts");
  });

  it.each(["steer", "queue"] as const)(
    "lets explicit manual %s replace an edited Auto item's captured policy",
    async (followUpMode) => {
      const original = {
        id: "manual-edit-auto",
        text: "Original text",
        createdAt: 1,
        deliveryPolicy: "auto" as const,
        queueMode: "followup" as const,
        sendState: "waiting-idle" as const,
        sessionKey: "agent:main:main",
        agentId: "main",
      };
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatQueue: [original],
        sessionKey: original.sessionKey,
        chatRunId: "active-run",
        settings: { chatAutoSteer: true, chatFollowUpMode: "steer" },
        isAutoSteerAvailable: () => true,
      });
      expect(
        admitQueuedMessageForSession(
          host,
          captureChatOutboxAdmission(host, host.sessionKey, original.agentId),
          original,
        ),
      ).toBe(true);
      expect(beginQueuedMessageEdit(host, original.id)).toBe("started");
      expect(updateQueuedMessageEdit(host, "Edited text")).toBe(true);
      await handleSendChat(host, "Edited text", {
        resumeQueuedMessageEditId: original.id,
        followUpMode,
      });
      if (followUpMode === "steer") {
        expect(findChatSendPayload(host)).toMatchObject({
          message: "Edited text",
          queueMode: "steer",
        });
        expect(findChatSendPayload(host)).not.toHaveProperty("deliveryPolicy");
      } else {
        expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
        expect(host.chatQueue).toHaveLength(1);
        expect(host.chatQueue[0]).toMatchObject({ text: "Edited text", sendState: "waiting-idle" });
        expect(host.chatQueue[0]?.deliveryPolicy).toBeUndefined();
      }
    },
  );

  it.each(["steer", "queue"] as const)(
    "captures Auto without replacing the %s baseline",
    async (chatFollowUpMode) => {
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage: "Keep the keyboard shortcuts",
        chatRunId: "active-run",
        settings: { chatAutoSteer: true, chatFollowUpMode },
        isAutoSteerAvailable: () => true,
      });
      await handleSendChat(host);
      expect(findChatSendPayload(host)).toMatchObject({
        deliveryPolicy: "auto",
        queueMode: chatFollowUpMode === "queue" ? "followup" : "steer",
      });
      expect(host.settings.chatFollowUpMode).toBe(chatFollowUpMode);
    },
  );

  it.each(["collect", "interrupt", "followup", "steer"] as const)(
    "lets the Gateway resolve inherited %s after Auto classification",
    async (chatFollowUpMode) => {
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage: "Keep the keyboard shortcuts",
        chatRunId: "active-run",
        chatFollowUpMode,
        settings: { chatAutoSteer: true },
        isAutoSteerAvailable: () => true,
      });
      await handleSendChat(host);
      const payload = findChatSendPayload(host);
      expect(payload.deliveryPolicy).toBe("auto");
      expect(payload).not.toHaveProperty("queueMode");
      expect(host.chatFollowUpMode).toBe(chatFollowUpMode);
      expect(host.settings.chatFollowUpMode).toBeUndefined();
    },
  );

  it.each(["collect", "interrupt"] as const)(
    "preserves inherited %s without Auto",
    async (chatFollowUpMode) => {
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage: "Keep the keyboard shortcuts",
        chatRunId: "active-run",
        chatFollowUpMode,
        settings: { chatAutoSteer: false },
        isAutoSteerAvailable: () => true,
      });
      await handleSendChat(host);
      const payload = findChatSendPayload(host);
      expect(payload).not.toHaveProperty("deliveryPolicy");
      expect(payload.queueMode).toBe(chatFollowUpMode);
    },
  );

  it.each(["steer", "collect", "interrupt"] as const)(
    "keeps explicit manual %s out of Auto",
    async (followUpMode) => {
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage: "Keep the keyboard shortcuts",
        chatRunId: "active-run",
        chatFollowUpMode: "collect",
        settings: { chatAutoSteer: true },
        isAutoSteerAvailable: () => true,
      });
      await handleSendChat(host, undefined, { followUpMode });
      const payload = findChatSendPayload(host);
      expect(payload).not.toHaveProperty("deliveryPolicy");
      expect(payload.queueMode).toBe(followUpMode);
      expect(host.chatFollowUpMode).toBe("collect");
      expect(host.settings.chatAutoSteer).toBe(true);
    },
  );

  it("keeps explicit manual Queue local while Auto is enabled", async () => {
    const host = makeChatHost({
      requestHandlers: { "chat.send": { status: "started" } },
      chatMessage: "Keep the keyboard shortcuts",
      chatRunId: "active-run",
      chatFollowUpMode: "interrupt",
      settings: { chatAutoSteer: true },
      isAutoSteerAvailable: () => true,
    });
    await handleSendChat(host, undefined, { followUpMode: "queue" });
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      text: "Keep the keyboard shortcuts",
      sendState: "waiting-idle",
    });
    expect(host.chatQueue[0]?.deliveryPolicy).toBeUndefined();
    expect(host.chatQueue[0]?.queueMode).toBeUndefined();
    expect(host.chatFollowUpMode).toBe("interrupt");
  });

  it.each(["off", "ineligible", "manual", "attachment-context"] as const)(
    "bypasses Auto for %s",
    async (mode) => {
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage: "Keep the keyboard shortcuts",
        chatRunId: "active-run",
        settings: { chatAutoSteer: mode !== "off", chatFollowUpMode: "steer" },
        isAutoSteerAvailable: () => mode !== "ineligible",
        ...(mode === "attachment-context"
          ? { getWorkContext: () => ({ page: "editor", title: "Private draft" }) }
          : {}),
      });
      await handleSendChat(
        host,
        undefined,
        mode === "manual" ? { followUpMode: "steer" } : undefined,
      );
      expect(findChatSendPayload(host)).not.toHaveProperty("deliveryPolicy");
      expect(host.settings.chatFollowUpMode).toBe("steer");
    },
  );

  it.each([false, true])(
    "uses a fresh manual admission only after a proven no-custody Auto rejection (proof: %s)",
    async (proven) => {
      const sent: Array<{ idempotencyKey: string; deliveryPolicy?: string; queueMode?: string }> =
        [];
      const failure = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Adviser failed before input delivery",
        ...(proven ? { details: { code: "CHAT_INPUT_NOT_ACQUIRED" } } : {}),
      });
      const host = makeChatHost({
        chatMessage: "Keep the original input",
        chatRunId: "active-run",
        settings: { chatAutoSteer: true, chatFollowUpMode: "queue" },
        isAutoSteerAvailable: () => true,
        requestHandlers: {
          "chat.send": (params: (typeof sent)[number]) => {
            sent.push(params);
            if (params.idempotencyKey === sent[0]?.idempotencyKey) {
              throw failure;
            }
            return { status: "started", runId: params.idempotencyKey };
          },
        },
      });
      await handleSendChat(host);
      expect(host.chatQueue[0]?.sendState).toBe("failed");
      expect(host.chatQueue[0]?.sendRejectedBeforeCustody).toBe(proven ? true : undefined);
      await steerQueuedChatMessage(host, host.chatQueue[0]!.id);
      // Retry may yield to its active drain; join the owner, not a microtask guess.
      await flushChatQueueForEvent(host);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.idempotencyKey === sent[0]?.idempotencyKey).toBe(!proven);
      expect(sent[1]?.queueMode).toBe("steer");
      expect(sent[1]).not.toHaveProperty("deliveryPolicy");
      expect(host.chatQueue[0]?.sendState).toBe(proven ? "sending" : "failed");
    },
  );

  it.each([false, true])(
    "manual Steer clears Auto while retry preserves it (manual: %s)",
    async (manual) => {
      const original = {
        id: "queued-auto",
        text: "Keep the keyboard shortcuts",
        createdAt: 1,
        deliveryPolicy: "auto" as const,
        queueMode: "followup" as const,
        sendRunId: "stable-input-id",
        sendAttempts: 1,
        sendState: "failed" as const,
        sessionKey: "agent:main:main",
        agentId: "main",
      };
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "ok", runId: original.sendRunId } },
        chatQueue: [original],
        sessionKey: original.sessionKey,
        settings: { chatAutoSteer: false, chatFollowUpMode: "queue" },
        isAutoSteerAvailable: () => false,
      });
      expect(
        admitQueuedMessageForSession(
          host,
          captureChatOutboxAdmission(host, host.sessionKey, original.agentId),
          original,
        ),
      ).toBe(true);
      if (manual) {
        await steerQueuedChatMessage(host, original.id);
      } else {
        await retryQueuedChatMessage(host, original.id);
      }
      const payload = findChatSendPayload(host);
      expect(payload.idempotencyKey).toBe(original.sendRunId);
      expect(payload.queueMode).toBe(manual ? "steer" : "followup");
      expect(payload.deliveryPolicy).toBe(manual ? undefined : "auto");
    },
  );
});

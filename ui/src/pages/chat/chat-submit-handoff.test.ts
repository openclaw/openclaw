// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { readStoredOutboxStore, storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import {
  flushChatQueueForEvent,
  moveQueuedChatMessage,
  resumeStoredChatOutboxes,
} from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import {
  listStoredChatOutboxes,
  updateStoredChatComposerQueueItem,
} from "./composer-persistence.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { beginQueuedMessageEdit, updateQueuedMessageEdit } from "./queued-message-edit.ts";

type TestChatHost = ReturnType<typeof makeChatHost>;
const requireRecord = createRequireRecord("object", "expected-label");

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

function idleChatHistory(sessionKey = "agent:main") {
  return {
    messages: [],
    sessionInfo: row(sessionKey, { hasActiveRun: false, status: "done" }),
  };
}

describe("chat submission handoff", () => {
  it("queues identical messages from distinct user actions while coalescing re-entry", async () => {
    const sent = createDeferred<unknown>();
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => sent.promise },
    });
    const firstAction = new Event("submit");
    const secondAction = new Event("submit");

    const first = handleSendChat(host, "same prompt", undefined, firstAction);
    const reentry = handleSendChat(host, "same prompt", undefined, firstAction);
    const second = handleSendChat(host, "same prompt", undefined, secondAction);

    await waitForFast(() =>
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1),
    );
    expect(host.chatQueue).toHaveLength(2);
    expect(host.chatQueue.map((item) => item.text)).toEqual(["same prompt", "same prompt"]);

    sent.resolve({ runId: host.chatQueue[0]?.sendRunId, status: "started" });
    await Promise.all([first, reentry, second]);
  });

  async function submitAcrossBrowserInput(
    host: TestChatHost,
    duringYield: (queued: ChatQueueItem) => void | Promise<void>,
  ): Promise<boolean | undefined> {
    const channel = new MessageChannel();
    const resume = channel.port2.postMessage.bind(channel.port2);
    const yielded = createDeferred();
    vi.spyOn(channel.port2, "postMessage").mockImplementation(() => yielded.resolve());
    vi.spyOn(globalThis, "MessageChannel").mockImplementationOnce(function () {
      return channel;
    });
    const submission = handleSendChat(host, undefined, undefined, new Event("submit"));
    try {
      await Promise.race([
        yielded.promise,
        submission.then(() => {
          throw new Error("Submission ended without yielding after admission");
        }),
      ]);
      const queued = expectDefined(listStoredChatOutboxes(host)[0]?.queue.at(-1), "admitted row");
      await duringYield(queued);
    } finally {
      resume(undefined);
      await submission;
      channel.port1.close();
      channel.port2.close();
    }
    return submission;
  }

  it.each([
    { policy: "default", predecessor: false, submitting: true },
    { policy: "queue", predecessor: false, submitting: false },
    { policy: "default", predecessor: true, submitting: true },
    { policy: "steer", predecessor: true, submitting: true },
    { policy: "queue", predecessor: true, submitting: false },
  ] as const)(
    "preserves active-run $policy admission during the input yield (older FIFO row: $predecessor)",
    async ({ policy, predecessor, submitting }) => {
      const host = makeChatHost({
        chatMessage: "follow up on the active run",
        chatRunId: "active-run",
        settings: { chatFollowUpMode: policy === "default" ? undefined : policy },
        requestHandlers: {
          "chat.history": {
            messages: [],
            sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
          },
          "chat.send": (params: unknown) => ({
            runId: requireRecord(params, "active-run default send").idempotencyKey,
            status: "started",
          }),
        },
      });
      if (predecessor) {
        await handleSendChat(host, "older queued input", { followUpMode: "queue" });
        expect(host.chatQueue).toEqual([
          expect.objectContaining({ text: "older queued input", sendState: "waiting-idle" }),
        ]);
      }
      const predecessorSnapshot = predecessor ? { ...host.chatQueue[0] } : undefined;
      let handoffState: ChatQueueItem["sendState"];
      const accepted = await submitAcrossBrowserInput(host, (queued) => {
        expect(queued).toMatchObject({ sendState: "waiting-idle", sendAttempts: 0 });
        expect(queued.queueMode).toBe(policy === "steer" ? "steer" : undefined);
        handoffState = host.chatQueue.find((item) => item.id === queued.id)?.sendState;
        expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      });

      expect(accepted).toBe(true);
      const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
      expect(sends).toHaveLength(submitting ? 1 : 0);
      if (submitting) {
        const payload = requireRecord(sends[0]?.[1], "active-run default send");
        expect(payload.message).toBe("follow up on the active run");
        expect(payload.queueMode).toBe(policy === "steer" ? "steer" : undefined);
      } else {
        expect(host.chatQueue.map((item) => item.text)).toEqual([
          ...(predecessor ? ["older queued input"] : []),
          "follow up on the active run",
        ]);
        expect(host.chatQueue.every((item) => item.sendState === "waiting-idle")).toBe(true);
      }
      expect(handoffState).toBe(submitting ? "submitting" : "waiting-idle");
      if (predecessorSnapshot) {
        expect(host.chatQueue.find((item) => item.id === predecessorSnapshot.id)).toEqual(
          predecessorSnapshot,
        );
      }
    },
  );

  it.each([false, true])(
    "retires an event-backed submission removed during the browser input yield (connected: %s)",
    async (connected) => {
      const host = makeChatHost({
        connected,
        requestHandlers: {},
        chatMessage: "discard before delivery",
        chatReplyTarget: { messageId: "quoted-message", text: "original quote" },
      });
      const accepted = await submitAcrossBrowserInput(host, (queued) => {
        expect(host.chatMessage).toBe("");
        expect(host.chatReplyTarget).toBeNull();
        expect(queued).toMatchObject({
          sendState: connected ? "waiting-idle" : "waiting-reconnect",
          sendAttempts: 0,
        });
        expect(host.chatQueue[0]?.sendState).toBe(connected ? "submitting" : "waiting-reconnect");
        expect(queued.text).toContain("discard before delivery");
        expect(removeQueuedMessage(host, queued.id)).toBe("removed");
        host.chatMessage = "next draft";
      });

      expect(accepted).toBe(true);
      expect(host.lastError).toBeNull();
      expect(host.chatReplyTarget).toBeNull();
      expect(host.chatMessage).toBe("next draft");
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.chatQueue).toEqual([]);
      expect(host.request).not.toHaveBeenCalled();
    },
  );

  it.each(["client", "epoch", "session", "recovery owner"])(
    "retires an event-backed continuation after its %s changes during the browser input yield",
    async (change) => {
      const host = makeChatHost({ requestHandlers: {}, chatMessage: "old owner input" });
      const newReply = { messageId: "same-message", text: "new owner quote" };
      host.chatReplyTarget = { messageId: newReply.messageId, text: "old owner quote" };
      const accepted = await submitAcrossBrowserInput(host, () => {
        if (change === "client") {
          host.client = createTestGatewayClient(host.request);
        } else if (change === "epoch") {
          host.connectionEpoch += 1;
        } else if (change === "session") {
          host.sessionKey = "agent:main:other";
        } else {
          vi.spyOn(
            expectDefined(host.client, "submission client"),
            "recoveryScope",
            "get",
          ).mockReturnValue("new-owner");
        }
        host.chatMessage = "new owner draft";
        host.chatReplyTarget = newReply;
      });
      expect(accepted).toBe(true);
      expect(host.request).not.toHaveBeenCalled();
      expect(host.lastError).toBeNull();
      expect(host.chatMessage).toBe("new owner draft");
      expect(host.chatReplyTarget).toBe(newReply);
      const stored = readStoredOutboxStore(
        sessionStorage,
        storageTargetForGateway(host.settings.gatewayUrl),
      );
      expect(Object.values(stored.sessions).flatMap((scope) => scope.queue ?? [])).toEqual([
        expect.objectContaining({ sessionKey: "agent:main", sendAttempts: 0 }),
      ]);
    },
  );

  it("keeps a replacement and a newer reply after the browser input yield", async () => {
    const host = makeChatHost({
      connected: false,
      requestHandlers: {},
      chatMessage: "original text",
      chatReplyTarget: { messageId: "same-message", text: "original quote" },
    });
    const newerReply = { messageId: "same-message", text: "selected again" };
    const accepted = await submitAcrossBrowserInput(host, async (queued) => {
      expect(beginQueuedMessageEdit(host, queued.id)).toBe("started");
      expect(updateQueuedMessageEdit(host, "replacement text")).toBe(true);
      expect(
        await handleSendChat(host, "replacement text", { resumeQueuedMessageEditId: queued.id }),
      ).toBe(true);
      host.chatMessage = "new draft";
      host.chatReplyTarget = newerReply;
    });
    expect(accepted).toBe(true);
    expect(host.lastError).toBeNull();
    expect(host.chatMessage).toBe("new draft");
    expect(host.chatReplyTarget).toBe(newerReply);
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
      expect.objectContaining({ text: "replacement text", sendAttempts: 0 }),
    ]);
    expect(host.request).not.toHaveBeenCalled();
  });

  it("defers a recipient-only queue replacement made during the browser input yield", async () => {
    const text = "@Alex please review";
    const originalMentions = [{ profileId: "profile-first", start: 0, end: 5 }];
    const replacementMentions = [{ profileId: "profile-second", start: 0, end: 5 }];
    const host = makeChatHost({
      chatMessage: text,
      chatMentions: originalMentions,
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": (params: unknown) => ({
          runId: requireRecord(params, "replacement recipient send").idempotencyKey,
          status: "started",
        }),
      },
    });
    let replacement: ChatQueueItem | undefined;
    const accepted = await submitAcrossBrowserInput(host, (queued) => {
      expect(queued.mentions).toEqual(originalMentions);
      replacement = { ...queued, mentions: replacementMentions };
      expect(
        updateStoredChatComposerQueueItem(
          host,
          host.sessionKey,
          queued,
          replacement,
          queued.agentId,
        ),
      ).toBe(true);
    });

    expect(accepted).toBe(true);
    expect(host.request).not.toHaveBeenCalled();
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([replacement]);

    await flushChatQueueForEvent(host);
    const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
    expect(sends.map(([, params]) => params)).toEqual([
      expect.objectContaining({ message: text, mentions: replacementMentions }),
    ]);
  });

  it.each(["edit hold", "reorder"])(
    "uses canonical queue arbitration after a browser input %s",
    async (change) => {
      const host = makeChatHost({
        connected: false,
        requestHandlers: {
          "chat.history": () => idleChatHistory(),
          "chat.send": (params: unknown) => ({
            runId: requireRecord(params, "canonical queued send").idempotencyKey,
            status: "started",
          }),
        },
        chatMessage: "first input",
      });
      const accepted = await submitAcrossBrowserInput(host, async (queued) => {
        await handleSendChat(host, "second input");
        if (change === "edit hold") {
          expect(beginQueuedMessageEdit(host, queued.id)).toBe("started");
          expect(updateQueuedMessageEdit(host, "correction in progress")).toBe(true);
        } else {
          moveQueuedChatMessage(host, queued.id, host.chatQueue[1]!.id);
        }
        host.connected = true;
      });
      expect(accepted).toBe(true);
      expect(host.lastError).toBeNull();
      const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
      if (change === "edit hold") {
        expect(sends).toEqual([]);
        expect(host.chatQueuedEdit?.draftText).toBe("correction in progress");
      } else {
        expect(sends.map(([, params]) => requireRecord(params, "send").message)).toEqual([
          "second input",
        ]);
      }
    },
  );

  it.each(
    ["started", "ok"].flatMap((ack) => [false, true].map((connected) => ({ ack, connected }))),
  )(
    "does not reacquire a $ack send advanced by reconnect during the browser input yield (initially connected: $connected)",
    async ({ ack, connected }) => {
      const host = makeChatHost({
        connected,
        requestHandlers: {
          "chat.history": () => idleChatHistory(),
          "chat.send": (params: unknown) => ({
            runId: requireRecord(params, "reconnect send").idempotencyKey,
            status: ack,
          }),
        },
        chatMessage: "one admitted turn",
      });
      let queueAfterReconnect: ChatQueueItem[] = [];
      const accepted = await submitAcrossBrowserInput(host, async (queued) => {
        expect(queued).toMatchObject({
          sendState: connected ? "waiting-idle" : "waiting-reconnect",
          sendAttempts: 0,
        });
        expect(host.chatQueue[0]?.sendState).toBe(connected ? "submitting" : "waiting-reconnect");
        if (connected) {
          host.connected = false;
          markQueuedChatSendsWaitingForReconnect(host);
          expect(host.chatQueue[0]).toMatchObject({
            sendState: "waiting-reconnect",
            sendAttempts: 0,
          });
          expect(host.request).not.toHaveBeenCalled();
        }
        host.connected = true;
        await resumeStoredChatOutboxes(host);
        expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(
          1,
        );
        queueAfterReconnect = [...host.chatQueue];
      });
      expect(accepted).toBe(true);
      expect(host.lastError).toBeNull();
      expect(host.chatQueue).toEqual(queueAfterReconnect);
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    },
  );
});

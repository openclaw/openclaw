// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { readStoredOutboxStore, storageTargetForComposer } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import {
  flushChatQueueForEvent,
  moveQueuedChatMessage,
  resumeStoredChatOutboxes,
} from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { createProps } from "./chat-thread.test-support.ts";
import {
  listStoredChatOutboxes,
  updateStoredChatComposerQueueItems,
} from "./composer-persistence.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { beginQueuedMessageEdit, updateQueuedMessageEdit } from "./queued-message-edit.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";

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

function chatHistory(active = false) {
  return {
    messages: [],
    sessionInfo: {
      key: "agent:main",
      kind: "direct",
      updatedAt: null,
      hasActiveRun: active,
      status: active ? "running" : "done",
    } satisfies GatewaySessionRow,
  };
}

function pendingInput(id: string, runId: string | undefined, content: string, timestamp: number) {
  return {
    id,
    runId,
    acceptedAt: timestamp,
    state: "queued" as const,
    message: { role: "user", content, timestamp },
  };
}

function yieldHost(chatMessage: string, overrides: Parameters<typeof makeChatHost>[0] = {}) {
  return makeChatHost({ requestHandlers: {}, chatMessage, ...overrides });
}

function expectAdmitted(host: TestChatHost, queued: ChatQueueItem, connected: boolean) {
  expect(queued).toMatchObject({
    sendState: connected ? "waiting-idle" : "waiting-reconnect",
    sendAttempts: 0,
  });
  expect(host.chatQueue[0]?.sendState).toBe(connected ? "submitting" : "waiting-reconnect");
}

function sends(host: TestChatHost) {
  return host.request.mock.calls.filter(([method]) => method === "chat.send");
}

function deliveryHandlers(status = "started", active = false) {
  return {
    "chat.history": () => chatHistory(active),
    "chat.send": (params: unknown) => ({
      runId: requireRecord(params, "queued send").idempotencyKey,
      status,
    }),
  };
}

describe("chat submission handoff", () => {
  it("keeps a setup-held original ahead of a steer through dispatch, custody, and persistence", async () => {
    const originalRunId = "setup-run";
    const original = pendingInput("original-input", originalRunId, "Original request", 10_000);
    const pendingInputs = { items: [original], total: 1 };
    const dispatched = createDeferred();
    const ack = createDeferred<unknown>();
    const host = makeChatHost({
      currentSessionId: "setup-session",
      chatRunId: originalRunId,
      requestHandlers: {
        "chat.history": {
          ...chatHistory(true),
          sessionId: "setup-session",
          pendingInputs,
        },
        "chat.send": () => {
          dispatched.resolve();
          return ack.promise;
        },
      },
    });
    const rows = () =>
      buildChatItems(
        createProps({
          messages: host.chatMessages,
          queue: host.chatQueue,
          pendingInputs: getChatPendingInputs(host)?.page.items,
          runId: host.chatRunId,
          runWorking: true,
        }),
      ).flatMap((item) =>
        item.kind === "group" ? item.messages.map(({ message }) => extractText(message)) : [],
      );
    await loadChatHistory(host);
    expect(rows()).toEqual(["Original request"]);
    const sending = handleSendChat(host, "Later steer", { followUpMode: "steer" });
    await dispatched.promise;
    const steer = expectDefined(host.chatQueue.at(-1), "steer submission");
    ack.resolve({ runId: steer.sendRunId, status: "accepted" });
    try {
      expect(rows()).toEqual(["Original request", "Later steer"]);
    } finally {
      await sending;
    }
    const later = pendingInput("steer-input", steer.sendRunId, "Later steer", 9_000);
    const inputs = [original, later];
    applyChatPendingInputs(host, { items: inputs, total: 2 });
    expect(rows()).toEqual(["Original request", "Later steer"]);
    for (const [index, input] of inputs.entries()) {
      applySessionMessagePayload(
        host,
        {
          message: {
            ...input.message,
            __openclaw: {
              id: input.id,
              seq: index + 1,
              idempotencyKey: input.runId + ":user",
              ...(index === 1 ? { steerTargetRunId: originalRunId } : {}),
            },
          },
        },
        true,
        { kind: "history-delta" },
      );
      expect(rows()).toEqual(["Original request", "Later steer"]);
    }
  });

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

    await waitForFast(() => expect(sends(host)).toHaveLength(1));
    expect(host.chatQueue.map((item) => item.text)).toEqual(["same prompt", "same prompt"]);

    sent.resolve({ runId: host.chatQueue[0]?.sendRunId, status: "started" });
    await Promise.all([first, reentry, second]);
  });

  async function submitAcrossBrowserInput(
    host: TestChatHost,
    duringYield: (queued: ChatQueueItem) => void | Promise<void>,
  ): Promise<void> {
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
    expect(await submission).toBe(true);
  }

  it.each([
    { policy: "default", submitting: true },
    { policy: "steer", submitting: true },
    { policy: "queue", submitting: false },
  ] as const)(
    "preserves active-run $policy admission alongside an older FIFO row during the input yield",
    async ({ policy, submitting }) => {
      const message = "follow up on the active run";
      const queueMode = policy === "steer" ? "steer" : undefined;
      const host = yieldHost(message, {
        chatRunId: "active-run",
        settings: { chatFollowUpMode: policy === "default" ? undefined : policy },
        requestHandlers: deliveryHandlers("started", true),
      });
      await handleSendChat(host, "older queued input", { followUpMode: "queue" });
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: "older queued input", sendState: "waiting-idle" }),
      ]);
      const predecessorSnapshot = { ...host.chatQueue[0] };
      let handoffState: ChatQueueItem["sendState"];
      await submitAcrossBrowserInput(host, (queued) => {
        expect(queued).toMatchObject({ sendState: "waiting-idle", sendAttempts: 0, queueMode });
        handoffState = host.chatQueue.find((item) => item.id === queued.id)?.sendState;
        expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      });

      const sent = sends(host);
      expect(sent).toHaveLength(submitting ? 1 : 0);
      if (submitting) {
        const payload = requireRecord(sent[0]?.[1], "active-run default send");
        expect(payload).toMatchObject({ message, queueMode });
      } else {
        expect(host.chatQueue.map((item) => item.text)).toEqual(["older queued input", message]);
        expect(host.chatQueue.every((item) => item.sendState === "waiting-idle")).toBe(true);
      }
      expect(handoffState).toBe(submitting ? "submitting" : "waiting-idle");
      expect(host.chatQueue.find((item) => item.id === predecessorSnapshot.id)).toEqual(
        predecessorSnapshot,
      );
    },
  );

  it.each([false, true])(
    "retires an event-backed submission removed during the browser input yield (connected: %s)",
    async (connected) => {
      const host = yieldHost("discard before delivery", {
        connected,
        chatReplyTarget: { messageId: "quoted-message", text: "original quote" },
      });
      await submitAcrossBrowserInput(host, (queued) => {
        expect(host).toMatchObject({ chatMessage: "", chatReplyTarget: null });
        expectAdmitted(host, queued, connected);
        expect(queued.text).toContain("discard before delivery");
        expect(removeQueuedMessage(host, queued.id)).toBe("removed");
        host.chatMessage = "next draft";
      });

      expect(host).toMatchObject({ lastError: null, chatMessage: "next draft" });
      expect(host.chatReplyTarget).toBeNull();
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.chatQueue).toEqual([]);
      expect(host.request).not.toHaveBeenCalled();
    },
  );

  it.each(["client", "epoch", "session", "recovery owner"])(
    "retires an event-backed continuation after its %s changes during the browser input yield",
    async (change) => {
      const host = yieldHost("old owner input");
      const originalTarget = storageTargetForComposer(host);
      const newReply = { messageId: "same-message", text: "new owner quote" };
      host.chatReplyTarget = { messageId: newReply.messageId, text: "old owner quote" };
      let admitted: ChatQueueItem | undefined;
      await submitAcrossBrowserInput(host, (queued) => {
        admitted = queued;
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
      expect(host.request).not.toHaveBeenCalled();
      expect(host).toMatchObject({ lastError: null, chatMessage: "new owner draft" });
      expect(host.chatReplyTarget).toBe(newReply);
      const stored = readStoredOutboxStore(sessionStorage, originalTarget);
      expect(admitted).toMatchObject({ sessionKey: "agent:main", sendAttempts: 0 });
      expect(Object.values(stored.sessions).flatMap((scope) => scope.queue ?? [])).toEqual([
        admitted,
      ]);
      if (change === "recovery owner") {
        expect(listStoredChatOutboxes(host)).toEqual([]);
      }
    },
  );

  it("keeps a replacement and a newer reply after the browser input yield", async () => {
    const host = yieldHost("original text", {
      connected: false,
      chatReplyTarget: { messageId: "same-message", text: "original quote" },
    });
    const newerReply = { messageId: "same-message", text: "selected again" };
    await submitAcrossBrowserInput(host, async (queued) => {
      expect(beginQueuedMessageEdit(host, queued.id)).toBe("started");
      expect(updateQueuedMessageEdit(host, "replacement text")).toBe(true);
      expect(
        await handleSendChat(host, "replacement text", { resumeQueuedMessageEditId: queued.id }),
      ).toBe(true);
      host.chatMessage = "new draft";
      host.chatReplyTarget = newerReply;
    });
    expect(host).toMatchObject({ lastError: null, chatMessage: "new draft" });
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
    const host = yieldHost(text, {
      chatMentions: originalMentions,
      requestHandlers: deliveryHandlers(),
    });
    let replacement: ChatQueueItem | undefined;
    await submitAcrossBrowserInput(host, (queued) => {
      expect(queued.mentions).toEqual(originalMentions);
      replacement = { ...queued, mentions: replacementMentions };
      expect(
        updateStoredChatComposerQueueItems(
          host,
          host.sessionKey,
          [{ expected: queued, next: replacement }],
          queued.agentId,
        ),
      ).toBe(true);
    });

    expect(host.request).not.toHaveBeenCalled();
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([replacement]);

    await flushChatQueueForEvent(host);
    expect(sends(host).map(([, params]) => params)).toEqual([
      expect.objectContaining({ message: text, mentions: replacementMentions }),
    ]);
  });

  it.each(["edit hold", "reorder"])(
    "uses canonical queue arbitration after a browser input %s",
    async (change) => {
      const host = yieldHost("first input", {
        connected: false,
        requestHandlers: deliveryHandlers(),
      });
      await submitAcrossBrowserInput(host, async (queued) => {
        await handleSendChat(host, "second input");
        if (change === "edit hold") {
          expect(beginQueuedMessageEdit(host, queued.id)).toBe("started");
          expect(updateQueuedMessageEdit(host, "correction in progress")).toBe(true);
        } else {
          moveQueuedChatMessage(host, queued.id, host.chatQueue[1]!.id);
        }
        host.connected = true;
      });
      expect(host.lastError).toBeNull();
      const sent = sends(host);
      if (change === "edit hold") {
        expect(sent).toEqual([]);
        expect(host.chatQueuedEdit?.draftText).toBe("correction in progress");
      } else {
        expect(sent.map(([, params]) => requireRecord(params, "send").message)).toEqual([
          "second input",
        ]);
      }
    },
  );

  it.each([
    { ack: "started", connected: true },
    { ack: "ok", connected: false },
  ])(
    "does not reacquire a $ack send advanced by reconnect during the browser input yield (initially connected: $connected)",
    async ({ ack, connected }) => {
      const host = yieldHost("one admitted turn", {
        connected,
        requestHandlers: deliveryHandlers(ack),
      });
      let queueAfterReconnect: ChatQueueItem[] = [];
      await submitAcrossBrowserInput(host, async (queued) => {
        expectAdmitted(host, queued, connected);
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
        expect(sends(host)).toHaveLength(1);
        queueAfterReconnect = [...host.chatQueue];
      });
      expect(host.lastError).toBeNull();
      expect(host.chatQueue).toEqual(queueAfterReconnect);
      expect(sends(host)).toHaveLength(1);
    },
  );
});

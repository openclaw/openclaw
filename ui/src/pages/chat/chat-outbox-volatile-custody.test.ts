import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createDraftFixture } from "../new-session/draft-submission-flow.test-support.ts";
import { completeInitialSessionTurn } from "../new-session/initial-session-turn-handoff.ts";
import { StartedSessionNavigation } from "../new-session/started-session-navigation.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentBlob,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { removeQueuedMessage, updateQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes, retryQueuedChatMessage } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import {
  listStoredChatOutboxes,
  removeStoredChatComposerQueueItem,
} from "./composer-persistence.ts";
import { admitInitialTurnHandoff } from "./initial-turn-handoff.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it.each([
  { subscribed: false, replacement: false },
  { subscribed: true, replacement: true },
])(
  "retains a genuinely volatile send across account return ($subscribed/$replacement)",
  async ({ subscribed, replacement }) => {
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    let account = "opaque-owner-a";
    let attempts = 0;
    const host = makeChatHost({
      chatMessage: "Only unsaved copy",
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "memory send");
          attempts += 1;
          if (attempts === 1) {
            throw new Error("gateway closed (1006): connection lost");
          }
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
    });
    const client = host.client!;
    vi.spyOn(client, "recoveryScope", "get").mockImplementation(() => account);
    const originalOwner = chatOutboxOwner(host);
    const stop = subscribed ? originalOwner.subscribe(host) : () => {};
    onTestFinished(stop);
    await handleSendChat(host);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toHaveLength(1);
    const original = host.chatQueue[0]!;
    expect(original).toMatchObject({
      text: "Only unsaved copy",
      sendState: "unconfirmed",
      sendAttempts: 1,
    });
    expect(originalOwner.hasVolatile(host, original.id)).toBe(true);
    const select = (next: string) => {
      account = next;
      if (replacement) {
        host.client = createTestGatewayClient(host.request);
        vi.spyOn(host.client, "recoveryScope", "get").mockImplementation(() => account);
      }
      host.connectionEpoch += 1;
      chatOutboxOwner(host).syncHost(host);
    };
    select("opaque-owner-b");
    expect(host.chatQueue).toEqual([]);
    expect(chatOutboxOwner(host).allItems(host)).toEqual([]);
    await retryQueuedChatMessage(host, original.id);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    select("opaque-owner-a");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: original.id,
        text: original.text,
        sendRunId: original.sendRunId,
        sendState: "unconfirmed",
      }),
    ]);
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    await retryQueuedChatMessage(host, original.id);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(2);
    expect(
      requireRecord(requestCalls(host.request, "chat.send")[1]![1], "retried memory send")
        .idempotencyKey,
    ).toBe(original.sendRunId);
    expect(host.chatQueue).toEqual([]);
    select("opaque-owner-b");
    select("opaque-owner-a");
    expect(host.chatQueue).toEqual([]);
  },
);

it.each(["retry", "discard"])(
  "keeps rejected initial-turn attachment bytes until explicit %s",
  async (action) => {
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const { context, request } = createDraftFixture({
      request: async (method, params) => {
        if (method === "chat.send") {
          const payload = requireRecord(params, "rejected initial retry");
          return { status: "started", runId: payload.idempotencyKey };
        }
        return {};
      },
    });
    const client = context.gateway.snapshot.client!;
    const originalAccount = client.recoveryScope;
    const sessionKey = "agent:main:rejected-file";
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "volatile-file",
        fileName: "private.txt",
        mimeType: "text/plain",
        sizeBytes: 7,
      },
      dataUrl: "data:text/plain;base64,cHJpdmF0ZQ==",
      file: new File(["private"], "private.txt", { type: "text/plain" }),
    });
    onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
    const clearDraft = vi.fn(async () => {});
    await completeInitialSessionTurn({
      context,
      client,
      agentId: "main",
      result: {
        key: sessionKey,
        initialRun: { status: "rejected", error: "Initial turn rejected" },
      },
      turn: { text: "Private rejected turn", attachments: [attachment], createdAt: 1 },
      instant: undefined,
      navigation: new StartedSessionNavigation(),
      isCurrent: () => true,
      clearDraft,
      completeInBackground: () => true,
      finishNavigation: vi.fn(),
    });
    expect(clearDraft).toHaveBeenCalledWith(false);
    const host = makeChatHost({
      client,
      sessionKey,
      settings: { gatewayUrl: context.gateway.connection.gatewayUrl },
    });
    const owner = chatOutboxOwner(host);
    const discarded = vi.fn();
    const stop = owner.subscribe(host, discarded);
    onTestFinished(stop);
    expect(admitInitialTurnHandoff(host, sessionKey)).toBe(true);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    const original = host.chatQueue[0]!;
    expect(original).toMatchObject({ text: "Private rejected turn", sendState: "failed" });
    const select = (value: string) => {
      Object.defineProperty(client, "recoveryScope", { configurable: true, value });
      host.connectionEpoch += 1;
      chatOutboxOwner(host).syncHost(host);
    };
    select("another-opaque-owner");
    expect(host.chatQueue).toEqual([]);
    expect(removeQueuedMessage(host, original.id, { discard: true })).toBe("absent");
    expect(getChatAttachmentDataUrl(attachment)).toBe("data:text/plain;base64,cHJpdmF0ZQ==");
    select(originalAccount);
    expect(host.chatQueue[0]?.attachments).toEqual([attachment]);
    expect(await getChatAttachmentBlob(attachment)?.text()).toBe("private");
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(request, "chat.send")).toHaveLength(0);
    if (action === "discard") {
      expect(removeQueuedMessage(host, original.id, { discard: true })).toBe("removed");
      expect(discarded).toHaveBeenCalledOnce();
      expect(getChatAttachmentBlob(attachment)).toBeNull();
    } else {
      await retryQueuedChatMessage(host, original.id);
      expect(requestCalls(request, "chat.send")).toHaveLength(1);
      expect(
        requireRecord(requestCalls(request, "chat.send")[0]![1], "attachment retry payload"),
      ).toMatchObject({
        message: original.text,
        attachments: [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "private.txt",
            content: "cHJpdmF0ZQ==",
          },
        ],
      });
      expect(discarded).not.toHaveBeenCalled();
    }
    expect(host.chatQueue).toEqual([]);
    select("another-opaque-owner");
    select(originalAccount);
    expect(host.chatQueue).toEqual([]);
    stop();
    await Promise.resolve();
    expect(chatOutboxOwner(host)).not.toBe(owner);
  },
);

it("parks an in-flight memory turn without resurrecting its retired sending operation", async () => {
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const entered = createDeferred();
  const reply = createDeferred<unknown>();
  let account = "owner-a";
  const host = makeChatHost({
    chatMessage: "In flight unsaved input",
    requestHandlers: {
      "chat.send": () => {
        entered.resolve();
        return reply.promise;
      },
    },
  });
  vi.spyOn(host.client!, "recoveryScope", "get").mockImplementation(() => account);
  const stop = chatOutboxOwner(host).subscribe(host);
  onTestFinished(stop);
  const sending = handleSendChat(host);
  await entered.promise;
  const original = host.chatQueue[0]!;
  expect(original.sendState).toBe("sending");
  try {
    account = "owner-b";
    host.connectionEpoch += 1;
    chatOutboxOwner(host).syncHost(host);
    expect(host.chatQueue).toEqual([]);
    account = "owner-a";
    host.connectionEpoch += 1;
    chatOutboxOwner(host).syncHost(host);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: original.id,
        text: original.text,
        sendRunId: original.sendRunId,
        sendAttempts: 1,
        sendState: "held",
      }),
    ]);
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  } finally {
    reply.reject(new Error("gateway closed (1006)"));
    await sending;
  }
  expect(host.chatQueue[0]?.sendState).toBe("held");
  expect(removeQueuedMessage(host, original.id, { discard: true })).toBe("removed");
});

it("does not revive submission authority or old presentation over a newer durable edit", async () => {
  let account = "owner-a";
  const host = makeChatHost({
    connected: false,
    chatMessage: "Original durable turn",
    requestHandlers: {},
  });
  vi.spyOn(host.client!, "recoveryScope", "get").mockImplementation(() => account);
  const owner = chatOutboxOwner(host);
  const stop = owner.subscribe(host);
  onTestFinished(stop);
  await handleSendChat(host);
  const original = host.chatQueue[0]!;
  const idle = updateQueuedMessage(host, original.id, (item) => ({
    ...item,
    sendState: "waiting-idle",
  }))!;
  const outbox = listStoredChatOutboxes(host)[0]!;
  const priorSubmission = owner.beginSubmission(host, idle.id, {
    inline: true,
    isCurrent: () => true,
  })!;
  expect(owner.hasPendingSubmission(outbox, idle)).toBe(true);
  expect(host.chatQueue[0]?.sendState).toBe("submitting");
  account = "owner-b";
  chatOutboxOwner(host).syncHost(host);
  expect(host.chatQueue).toEqual([]);
  const peer = makeChatHost({ client: createTestGatewayClient(host.request) });
  vi.spyOn(peer.client!, "recoveryScope", "get").mockReturnValue("owner-a");
  expect(
    updateQueuedMessage(peer, idle.id, (item) => ({ ...item, text: "New durable edit" })),
  ).toMatchObject({ text: "New durable edit" });
  account = "owner-a";
  chatOutboxOwner(host).syncHost(host);
  const current = host.chatQueue[0]!;
  expect(current).toMatchObject({ text: "New durable edit", sendState: "waiting-idle" });
  expect(owner.hasPendingSubmission(outbox, current)).toBe(false);
  const currentSubmission = owner.beginSubmission(host, current.id, {
    inline: true,
    isCurrent: () => true,
  })!;
  priorSubmission.release();
  expect(owner.hasPendingSubmission(outbox, current)).toBe(true);
  expect(host.chatQueue[0]).toMatchObject({ text: "New durable edit", sendState: "submitting" });
  currentSubmission.release();
  expect(removeQueuedMessage(host, original.id, { discard: true })).toBe("removed");
  expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
});

it("moves peer panes together while retaining each volatile input under its original owner", async () => {
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  let account = "owner-a";
  const left = makeChatHost({
    chatMessage: "Left private input",
    requestHandlers: {
      "chat.send": () => {
        throw new Error("gateway closed (1006)");
      },
    },
  });
  const right = makeChatHost({ client: left.client, chatMessage: "Right private input" });
  vi.spyOn(left.client!, "recoveryScope", "get").mockImplementation(() => account);
  const stopLeft = chatOutboxOwner(left).subscribe(left);
  const stopRight = chatOutboxOwner(right).subscribe(right);
  onTestFinished(() => {
    stopLeft();
    stopRight();
  });
  await handleSendChat(left);
  await handleSendChat(right);
  const leftInput = left.chatQueue[0]!;
  const rightInput = right.chatQueue[0]!;
  expect(leftInput.text).toBe("Left private input");
  expect(rightInput.text).toBe("Right private input");
  account = "owner-b";
  chatOutboxOwner(left).syncHost(left);
  expect(left.chatQueue).toEqual([]);
  expect(right.chatQueue).toEqual([]);
  account = "owner-a";
  chatOutboxOwner(right).syncHost(right);
  expect(left.chatQueue).toEqual([
    expect.objectContaining({ id: leftInput.id, text: leftInput.text }),
  ]);
  expect(right.chatQueue).toEqual([
    expect.objectContaining({ id: rightInput.id, text: rightInput.text }),
  ]);
  await resumeStoredChatOutboxes(left);
  await resumeStoredChatOutboxes(right);
  expect(requestCalls(left.request, "chat.send")).toHaveLength(2);
  expect(removeQueuedMessage(left, leftInput.id, { discard: true })).toBe("removed");
  expect(right.chatQueue[0]?.id).toBe(rightInput.id);
  expect(removeQueuedMessage(right, rightInput.id, { discard: true })).toBe("removed");
});

it.each([
  { returnBeforeDiscard: false, offscreen: false },
  { returnBeforeDiscard: true, offscreen: false },
  { returnBeforeDiscard: false, offscreen: true },
])(
  "retires saved volatile custody before peer discard ($returnBeforeDiscard/$offscreen)",
  async ({ returnBeforeDiscard, offscreen }) => {
    const failedStorage = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    let account = "owner-a";
    const source = makeChatHost({
      chatMessage: "Old volatile text",
      requestHandlers: {
        "chat.send": () => {
          throw new Error("gateway closed (1006)");
        },
      },
    });
    vi.spyOn(source.client!, "recoveryScope", "get").mockImplementation(() => account);
    const stop = chatOutboxOwner(source).subscribe(source);
    onTestFinished(stop);
    await handleSendChat(source);
    const original = source.chatQueue[0]!;
    account = "owner-b";
    chatOutboxOwner(source).syncHost(source);
    failedStorage.mockRestore();
    const peer = makeChatHost({ client: createTestGatewayClient(source.request) });
    vi.spyOn(peer.client!, "recoveryScope", "get").mockReturnValue("owner-a");
    if (offscreen) {
      peer.sessionKey = "agent:main:other";
    }
    expect(
      chatOutboxOwner(peer).admit(peer, captureChatOutboxAdmission(peer, original.sessionKey!), {
        ...original,
        text: "Newer durable peer edit",
      }),
    ).toBe("admitted");
    if (returnBeforeDiscard) {
      account = "owner-a";
      chatOutboxOwner(source).syncHost(source);
      expect(source.chatQueue[0]?.text).toBe("Newer durable peer edit");
      expect(chatOutboxOwner(source).hasVolatile(source, original.id)).toBe(false);
    }
    if (offscreen) {
      const saved = listStoredChatOutboxes(peer)[0]!;
      expect(
        removeStoredChatComposerQueueItem(
          peer,
          saved.sessionKey,
          original.id,
          saved.queue[0]!,
          saved.agentId,
        ),
      ).toBe(true);
    } else {
      expect(removeQueuedMessage(peer, original.id, { discard: true })).toBe("removed");
    }
    account = "owner-a";
    chatOutboxOwner(source).syncHost(source);
    expect(source.chatQueue).toEqual([]);
    expect(chatOutboxOwner(source).allItems(source)).toEqual([]);
    account = "owner-b";
    chatOutboxOwner(source).syncHost(source);
    account = "owner-a";
    chatOutboxOwner(source).syncHost(source);
    expect(source.chatQueue).toEqual([]);
  },
);

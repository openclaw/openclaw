import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createDraftFixture,
  registerTextPayload,
} from "../new-session/draft-submission-flow.test-support.ts";
import { completeInitialSessionTurn } from "../new-session/initial-session-turn-handoff.ts";
import { StartedSessionNavigation } from "../new-session/started-session-navigation.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentBlob,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { makeChatHost, requestCalls, requireRecord } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { removeQueuedMessage, updateQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes, retryQueuedChatMessage } from "./chat-send-actions.ts";
import { settleQueuedChatSendFailure } from "./chat-send-queue-runtime.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { updateStoredChatComposerQueueItems } from "./composer-queue-persistence.ts";
import { admitInitialTurnHandoff } from "./initial-turn-handoff-admission.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

function failStorageWrites(error: Error = new Error("quota")) {
  return vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw error;
  });
}

function custodyHost(
  options: Parameters<typeof makeChatHost>[0],
  subscribed = true,
  replacement = false,
  initialAccount = "owner-a",
  discarded?: () => void,
) {
  const host = makeChatHost({
    requestHandlers: {
      "chat.send": () => {
        throw new Error("gateway closed (1006)");
      },
    },
    ...options,
  });
  let account = initialAccount;
  vi.spyOn(host.client!, "recoveryScope", "get").mockImplementation(() => account);
  const owner = chatOutboxOwner(host);
  const stop = subscribed ? owner.subscribe(host, discarded) : () => {};
  onTestFinished(stop);
  const select = (
    next: string,
    advanceEpoch = false,
    source: ReturnType<typeof makeChatHost> = host,
  ) => {
    account = next;
    if (replacement) {
      host.client = createTestGatewayClient(host.request);
      vi.spyOn(host.client, "recoveryScope", "get").mockImplementation(() => account);
    }
    if (advanceEpoch) {
      host.connectionEpoch += 1;
    }
    chatOutboxOwner(source).syncHost(source);
  };
  return { host, owner, select, stop };
}

it.each([
  { mode: "replay", replacement: false },
  { mode: "replay", replacement: true },
  { mode: "held", replacement: false },
  { mode: "retired", replacement: false },
] as const)("preserves $mode custody ($replacement)", async ({ mode, replacement }) => {
  if (mode !== "retired") {
    failStorageWrites(new DOMException("quota exceeded", "QuotaExceededError"));
  }
  const entered = createDeferred();
  const reply = createDeferred<unknown>();
  let attempts = 0;
  const {
    host,
    owner,
    select: changeAccount,
  } = custodyHost(
    {
      chatMessage: "Only unsaved copy",
      currentSessionId: mode === "replay" ? "volatile-original-session" : undefined,
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "memory send");
          attempts += 1;
          entered.resolve();
          if (attempts > 1) {
            return { runId: payload.idempotencyKey, status: "started" };
          }
          if (mode === "replay") {
            throw new Error("gateway closed (1006): connection lost");
          }
          return reply.promise;
        },
      },
    },
    mode === "replay" ? replacement : true,
    replacement,
  );
  const select = (next: string) => changeAccount(next, true);
  const sending = handleSendChat(host);
  await entered.promise;
  if (mode === "replay") {
    await sending;
  }
  const original = host.chatQueue[0]!;
  try {
    expect(original.sendState).toBe(mode === "replay" ? "waiting-reconnect" : "sending");
    expect(original.sendAttempts).toBe(1);
    if (mode === "retired") {
      expect(owner.remove(host, original.id)?.id).toBe(original.id);
    } else {
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(owner.hasVolatile(host, original.id)).toBe(true);
      select("owner-b");
      expect(host.chatQueue).toEqual([]);
      expect(chatOutboxOwner(host).allItems(host)).toEqual([]);
      if (mode === "replay") {
        await retryQueuedChatMessage(host, original.id);
      }
      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
      select("owner-a");
      const { id, text, sendRunId } = original;
      const sendState = mode === "held" ? "held" : "waiting-reconnect";
      expect(host.chatQueue).toMatchObject([{ id, text, sendRunId, sendState }]);
      expect(host.chatQueue[0]?.sendAttempts).toBe(1);
      await resumeStoredChatOutboxes(host);
    }
  } finally {
    if (mode !== "replay") {
      reply.reject(
        new GatewayRequestError({ code: "UNAVAILABLE", message: "closed", retryable: true }),
      );
      await sending;
    }
  }
  expect(requestCalls(host.request, "chat.send")).toHaveLength(mode === "replay" ? 2 : 1);
  if (mode === "held") {
    expect(host.chatQueue[0]?.sendState).toBe("held");
    expect(removeQueuedMessage(host, original.id, { discard: true })).toBe("removed");
  } else if (mode === "replay") {
    expect(requestCalls(host.request, "chat.send")[1]?.[1]).toMatchObject({
      idempotencyKey: original.sendRunId,
    });
  }
  expect(host.chatMessage).toBe("");
  expect(host.chatError ?? null).toBeNull();
  expect(host.lastError ?? null).toBeNull();
  select("owner-b");
  select("owner-a");
  expect(host.chatQueue).toEqual([]);
});

it.each(["retry", "discard"])(
  "keeps rejected initial-turn attachment bytes until explicit %s",
  async (action) => {
    failStorageWrites(new DOMException("quota", "QuotaExceededError"));
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
    const sessionKey = "agent:main:rejected-file";
    const attachment = registerTextPayload("private");
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
    const originalAccount = client.recoveryScope;
    const discarded = vi.fn();
    const fixture = custodyHost(
      { client, sessionKey, settings: { gatewayUrl: context.gateway.connection.gatewayUrl } },
      true,
      false,
      originalAccount,
      discarded,
    );
    const { host, owner, stop } = fixture;
    const select = (value: string) => fixture.select(value, true);
    expect(admitInitialTurnHandoff(host, sessionKey)).toBe(true);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    const original = host.chatQueue[0]!;
    expect(original).toMatchObject({ text: "Private rejected turn", sendState: "failed" });
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
      expect(requestCalls(request, "chat.send")[0]?.[1]).toMatchObject({
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

it("does not revive submission authority or old presentation over a newer durable edit", async () => {
  const { host, owner, select } = custodyHost({
    connected: false,
    chatMessage: "Original durable turn",
    requestHandlers: {},
  });
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
  select("owner-b");
  expect(host.chatQueue).toEqual([]);
  const peer = makeChatHost({ client: createTestGatewayClient(host.request) });
  vi.spyOn(peer.client!, "recoveryScope", "get").mockReturnValue("owner-a");
  expect(
    updateQueuedMessage(peer, idle.id, (item) => ({ ...item, text: "New durable edit" })),
  ).toMatchObject({ text: "New durable edit" });
  select("owner-a");
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

it.each(["durable", "memory"] as const)(
  "keeps a send row retired mid-flight pending without a delivery failure (%s)",
  (storageMode) => {
    const host = makeChatHost({ sessionKey: "agent:main:retired" });
    const queued = {
      id: "retired-send",
      text: "Retired by a live receipt before this failure landed",
      createdAt: 1,
    };
    host.chatQueue = [queued];
    // A live custody receipt or peer pane removed the row while the request
    // was still in flight; only its failure lands afterwards.
    host.chatQueue = [];
    const scheduleRetry = vi.fn();
    const result = settleQueuedChatSendFailure(
      host,
      queued,
      { ...queued, sendRunId: "retired-run" },
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "gateway closed (1006)",
        retryable: true,
        retryAfterMs: 250,
      }),
      { storageMode },
      { sessionKey: host.sessionKey },
      scheduleRetry,
    );
    expect(result).toBe("pending");
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(host.chatQueue).toEqual([]);
    expect(host.chatError ?? null).toBeNull();
    expect(host.lastError ?? null).toBeNull();
  },
);

it("moves peer panes together while retaining each volatile input under its original owner", async () => {
  failStorageWrites();
  const { host: left, select } = custodyHost({
    chatMessage: "Left private input",
  });
  const right = makeChatHost({
    client: left.client,
    sessionKey: "agent:main:right",
    chatMessage: "Right private input",
  });
  onTestFinished(chatOutboxOwner(right).subscribe(right));
  await handleSendChat(left);
  await handleSendChat(right);
  const leftInput = left.chatQueue[0]!;
  const rightInput = right.chatQueue[0]!;
  expect(leftInput.text).toBe("Left private input");
  expect(rightInput.text).toBe("Right private input");
  select("owner-b");
  expect(left.chatQueue).toEqual([]);
  expect(right.chatQueue).toEqual([]);
  select("owner-a", false, right);
  expect(left.chatQueue).toMatchObject([{ id: leftInput.id, text: leftInput.text }]);
  expect(right.chatQueue).toMatchObject([{ id: rightInput.id, text: rightInput.text }]);
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
    const failedStorage = failStorageWrites();
    const { host: source, select } = custodyHost({
      chatMessage: "Old volatile text",
    });
    await handleSendChat(source);
    const original = source.chatQueue[0]!;
    select("owner-b");
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
      select("owner-a");
      expect(source.chatQueue[0]?.text).toBe("Newer durable peer edit");
      expect(chatOutboxOwner(source).hasVolatile(source, original.id)).toBe(false);
    }
    if (offscreen) {
      const saved = listStoredChatOutboxes(peer)[0]!;
      expect(
        updateStoredChatComposerQueueItems(
          peer,
          saved.sessionKey,
          [{ expected: saved.queue[0]!, next: null }],
          saved.agentId,
        ),
      ).toBe(true);
    } else {
      expect(removeQueuedMessage(peer, original.id, { discard: true })).toBe("removed");
    }
    select("owner-a");
    expect(source.chatQueue).toEqual([]);
    expect(chatOutboxOwner(source).allItems(source)).toEqual([]);
    select("owner-b");
    select("owner-a");
    expect(source.chatQueue).toEqual([]);
  },
);

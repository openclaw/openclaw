// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import * as outboxPayloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  createDeliveryAttachmentBatch,
  reloadChatDocumentStorage,
} from "./chat-delivery-attachments.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost, makeRequestMock } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems } from "./chat-outbox-recovery.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { keepVolatileQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import * as chatSendSupport from "./chat-send-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { loadChatComposerState } from "./composer-draft-storage.ts";
import { updateStoredChatComposerQueueItems } from "./composer-queue-persistence.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

type DeliveredTurnRetirement = Awaited<
  ReturnType<typeof chatSendSupport.retireDeliveredQueuedUserTurn>
>;
const requireRecord = createRequireRecord("object", "expected-label");

function idleChatHistory(sessionKey: string) {
  return {
    messages: [],
    sessionInfo: {
      key: sessionKey,
      kind: "direct",
      updatedAt: null,
      hasActiveRun: false,
      status: "done",
    },
  };
}

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deliveredAttachmentUrls(message: unknown): unknown[] {
  const content = requireRecord(message, "delivered user turn").content as Array<
    Record<string, unknown>
  >;
  return content.flatMap((block) =>
    block.type === "image"
      ? [block.url]
      : block.type === "attachment"
        ? [requireRecord(block.attachment, "delivered attachment").url]
        : [],
  );
}

it.each(["visible", "inactive"])(
  "pins attachment bytes before ACK retires the %s outbox",
  async (view) => {
    const { attachments, dataUrls } = createDeliveryAttachmentBatch();
    const sessionKey = "agent:main:ack-attachments";
    const started = createDeferred<string>();
    const acknowledgment = createDeferred<unknown>();
    const source = makeChatHost({
      sessionKey,
      chatMessage: "Keep the accepted attachments",
      chatAttachments: attachments.map((attachment, index) => ({
        ...attachment,
        previewUrl: `blob:ack-preview-${index}`,
      })),
      requestHandlers: {
        "chat.send": (params: unknown) => {
          started.resolve(String(requireRecord(params, "attachment ACK").idempotencyKey));
          return acknowledgment.promise;
        },
      },
    });
    source.chatMessagesBySession = new Map();
    const stop = chatOutboxOwner(source).subscribe(source);
    const sending = handleSendChat(source);
    try {
      const runId = await started.promise;
      expect(listStoredChatOutboxes(source)).toHaveLength(1);
      if (view === "inactive") {
        cacheChatSessionSnapshot(
          source.chatMessagesBySession,
          source,
          { sessionKey },
          {
            messages: [],
            sessionId: "ack-attachment-session",
            pagination: { hasMore: false, completeSnapshot: true },
          },
        );
        source.sessionKey = "agent:main:other";
      }
      acknowledgment.resolve({ runId, status: "started" });
      await sending;
      expect(listStoredChatOutboxes(source)).toEqual([]);
      const messages =
        view === "visible"
          ? source.chatMessages
          : readChatMessagesFromCache(source.chatMessagesBySession, source, { sessionKey });
      expect(messages.map(extractText)).toContain("Keep the accepted attachments");
      expect(deliveredAttachmentUrls(messages[0])).toEqual(dataUrls);
      reloadChatDocumentStorage(attachments);
      expect(deliveredAttachmentUrls(messages[0])).toEqual(dataUrls);
    } finally {
      acknowledgment.resolve({ status: "started" });
      await sending;
      stop();
    }
  },
);

it.each(
  ["durable", "memory"].flatMap((storageMode) =>
    [false, true].map((committed) => ({ storageMode, committed })),
  ),
)(
  "reconciles $storageMode duplicate ACK display only with a committed input receipt ($committed)",
  async ({ storageMode, committed }) => {
    const sessionKey = "agent:main:replayed";
    const sessionId = "replayed-session";
    const runId = "replayed-input";
    const prompt = "Already submitted input";
    const reply = {
      role: "assistant",
      content: "Latest visible reply",
      __openclaw: { id: "latest", seq: 605 },
    };
    const queued = {
      id: "replayed-outbox",
      text: prompt,
      createdAt: 1,
      sessionKey,
      sessionId,
      sendRunId: runId,
      sendAttempts: 1,
      sendState: "waiting-reconnect" as const,
    };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      chatMessages: [reply],
      chatHistoryPagination: { hasMore: true, nextOffset: 80, totalMessages: 605 },
      chatQueue: storageMode === "durable" ? [queued] : [],
      requestHandlers: {
        "chat.send": { runId, status: "ok", ...(committed ? { messageSeq: 489 } : {}) },
        "chat.history": {
          sessionId,
          messages: [reply],
          hasMore: true,
          nextOffset: 80,
          totalMessages: 605,
          sessionInfo: { key: sessionKey, sessionId, hasActiveRun: false, status: "done" },
        },
      },
    });
    if (storageMode === "durable") {
      admitHostQueueItems(host);
    } else {
      keepVolatileQueuedMessage(host, sessionKey, queued, undefined, { retryable: true });
    }
    const stop = chatOutboxOwner(host).subscribe(host);
    try {
      await resumeStoredChatOutboxes(host);
      await loadChatHistory(host);
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.chatMessages.map(extractText).filter((text) => text === prompt)).toHaveLength(
        committed ? 0 : 1,
      );
      expect(host.chatMessages.map(extractText)).toContain("Latest visible reply");
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    } finally {
      stop();
    }
  },
);

describe("chat attachment terminal retirement", () => {
  it.each([
    "live",
    "cold",
    "new-credentials",
    "new-attempt",
    "new-run",
    "consumed-before-read",
    "consumed-after-read",
  ])("pins lost-ACK attachment turns to durable data across split panes (%s)", async (handoff) => {
    const consumesDuringHydration = handoff.startsWith("consumed-");
    const { attachments, dataUrls } = createDeliveryAttachmentBatch();
    const sessionKey = "agent:main:visible";
    const history = createDeferred<unknown>();
    let holdHistory = false;
    let consumedRunId: string | undefined;
    const consumedHistory = () => ({
      messages: [],
      inputReceipts: consumedRunId
        ? [{ runId: consumedRunId, state: "consumed", consumedByEventId: "attachment-user" }]
        : [],
    });
    const request = makeRequestMock({
      "chat.history": () =>
        consumedRunId
          ? consumedHistory()
          : holdHistory
            ? history.promise
            : idleChatHistory(sessionKey),
      "chat.send": () => {
        throw new Error("Gateway disconnected before acknowledgment");
      },
    });
    const presentedAttachments =
      handoff === "live"
        ? attachments.map((attachment, index) => ({ ...attachment, dataUrl: dataUrls[index] }))
        : attachments;
    const source = makeChatHost({
      client: createTestGatewayClient(request),
      sessionKey,
      chatMessage: "summarize",
      chatAttachments: presentedAttachments,
    });
    sessionStorage.setItem("openclaw.control.outboxTab.v1", "test-outbox-tab");
    const stopSource = chatOutboxOwner(source).subscribe(source);
    let stopVisible = () => {};
    let stopInactive = () => {};
    const hydration = createDeferred();
    const pendingReads: Array<ReturnType<typeof outboxPayloadStore.readOutboxPayload>> = [];
    const completedReads: Array<ReturnType<typeof outboxPayloadStore.readOutboxPayload>> = [];
    const pendingRetirements: Promise<DeliveredTurnRetirement>[] = [];
    try {
      await handleSendChat(source);
      holdHistory = true;
      const item = expectDefined(
        loadChatComposerState(source, sessionKey).snapshot?.queue[0],
        "Blob-backed terminal send",
      );
      expect(item.attachmentPayload).toBeDefined();
      expect(item.attachments?.map((attachment) => attachment.dataUrl)).toEqual([
        undefined,
        undefined,
      ]);
      if (handoff !== "live") {
        stopSource();
        reloadChatDocumentStorage(attachments);
      }
      const client =
        handoff === "live"
          ? expectDefined(source.client, "live client")
          : createTestGatewayClient(request);
      const visible = handoff === "live" ? source : makeChatHost({ client, sessionKey });
      if (consumesDuringHydration) {
        adoptStartedChatRun(
          visible,
          expectDefined(item.sendRunId, "active attachment run"),
          Date.now(),
        );
      }
      const inactive = makeChatHost({
        client,
        chatSubmissions: visible.chatSubmissions,
        sessionKey: "agent:main:inactive",
      });
      for (const host of [visible, inactive]) {
        Object.assign(host, {
          chatMessagesBySession: new Map(),
          connectionEpoch: 1,
          pendingSessionMessageReloadSessionKey: null,
        });
      }
      cacheChatSessionSnapshot(
        expectDefined(inactive.chatMessagesBySession, "inactive message cache"),
        inactive,
        { sessionKey },
        {
          messages: [],
          pagination: { hasMore: false, completeSnapshot: true },
          sessionId: "cached-session",
        },
      );
      const readPayload = outboxPayloadStore.readOutboxPayload;
      const read = vi
        .spyOn(outboxPayloadStore, "readOutboxPayload")
        .mockImplementation((...args) => {
          const completed = handoff === "consumed-after-read" ? readPayload(...args) : null;
          if (completed) {
            completedReads.push(completed);
          }
          const pending = hydration.promise.then(() => completed ?? readPayload(...args));
          pendingReads.push(pending);
          return pending;
        });
      if (handoff !== "live") {
        stopVisible = chatOutboxOwner(visible).subscribe(visible);
        expect(visible.chatQueue[0]?.attachments?.map(getChatAttachmentDataUrl)).toEqual([
          null,
          null,
        ]);
      }
      stopInactive = chatOutboxOwner(inactive).subscribe(inactive);
      const removePayloads = outboxPayloadStore.removeOutboxPayloads;
      const cleanup = vi
        .spyOn(outboxPayloadStore, "removeOutboxPayloads")
        .mockImplementation(async (refs) => {
          const cached = readChatMessagesFromCache(
            inactive.chatMessagesBySession ?? new Map(),
            inactive,
            { sessionKey },
          );
          if (!consumesDuringHydration) {
            expect(deliveredAttachmentUrls(cached[0])).toEqual(dataUrls);
          }
          await removePayloads(refs);
        });
      const event = {
        event: "chat",
        payload: {
          state: "final",
          runId: item.sendRunId,
          sessionKey,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "terminal reply" }],
            timestamp: Date.now(),
          },
        },
      } as Parameters<typeof handlePageGatewayEvent>[1];
      const retirementOwner = vi.spyOn(chatSendSupport, "retireDeliveredQueuedUserTurn");
      expect(handlePageGatewayEvent(inactive as ChatPageHost, event)).toBeUndefined();
      expect(handlePageGatewayEvent(visible as ChatPageHost, event)).toBeUndefined();
      expect(retirementOwner).toHaveBeenCalledTimes(2);
      // Dispatch registers its finish callback before this test observes owner completion.
      for (const result of retirementOwner.mock.results) {
        if (result.type !== "return") {
          throw new Error("Expected the real retirement owner to return normally");
        }
        pendingRetirements.push(Promise.resolve(result.value));
      }
      if (handoff === "live") {
        // Both panes pin display bytes; the durable payload still awaits consumption.
        expect(retirementOwner).toHaveNthReturnedWith(1, "retained");
        expect(retirementOwner).toHaveNthReturnedWith(2, "retained");
        expect(read).not.toHaveBeenCalled();
      } else {
        await waitForFast(() => expect(read).toHaveBeenCalled());
        expect(listStoredChatOutboxes(visible)[0]?.queue[0]?.id).toBe(item.id);
        expect(cleanup).not.toHaveBeenCalled();
      }
      const credential =
        handoff === "new-credentials"
          ? vi.spyOn(client, "recoveryScope", "get").mockReturnValue("different-credential")
          : null;
      if (handoff === "new-attempt") {
        expect(
          updateStoredChatComposerQueueItems(
            visible,
            sessionKey,
            [
              {
                expected: item,
                next: {
                  ...item,
                  sendRunId: "replacement-attempt",
                  sendAttempts: 2,
                },
              },
            ],
            item.agentId,
          ),
        ).toBe(true);
      }
      if (handoff === "new-run") {
        adoptStartedChatRun(visible, "newer-run", Date.now());
        visible.chatStream = "newer run is still streaming";
      }
      if (consumesDuringHydration) {
        // The canonical input receipt can retire local retry bytes while
        // the earlier terminal is still waiting for its Blob handoff.
        for (const result of await Promise.all(completedReads)) {
          expect(result.status).toBe("ready");
        }
        consumedRunId = item.sendRunId;
        applyChatPendingInputs(
          visible,
          { items: [], total: 0 },
          {
            receipts: [
              { runId: item.sendRunId!, state: "consumed", consumedByEventId: "attachment-user" },
            ],
          },
        );
        expect(listStoredChatOutboxes(visible)).toStrictEqual([]);
      }
      hydration.resolve();
      await Promise.all(pendingRetirements);
      credential?.mockRestore();
      if (consumesDuringHydration) {
        expect(visible.chatRunId).toBeNull();
        expect(visible.chatStream).toBeNull();
        expect(visible.chatMessages.map(extractText)).toContain("terminal reply");
        expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
        return;
      }
      if (handoff === "new-credentials" || handoff === "new-attempt") {
        expect(cleanup).not.toHaveBeenCalled();
        expect(loadChatComposerState(visible, sessionKey).snapshot?.queue[0]).toMatchObject({
          id: item.id,
          attachmentPayload: item.attachmentPayload,
          sendRunId: handoff === "new-attempt" ? "replacement-attempt" : item.sendRunId,
        });
        expect(visible.chatMessages).toEqual([]);
        expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
        return;
      }

      expect(
        visible.chatMessages.map((message) => requireRecord(message, "terminal transcript").role),
      ).toEqual(["user", "assistant"]);
      expect(deliveredAttachmentUrls(visible.chatMessages[0])).toEqual(dataUrls);
      if (handoff === "new-run") {
        expect(visible.chatRunId).toBe("newer-run");
        expect(visible.chatStream).toBe("newer run is still streaming");
      }
      const inactiveCached = readChatMessagesFromCache(
        inactive.chatMessagesBySession ?? new Map(),
        inactive,
        { sessionKey },
      );
      expect(deliveredAttachmentUrls(inactiveCached[0])).toEqual(dataUrls);
      expect(listStoredChatOutboxes(visible)[0]?.queue[0]).toMatchObject({
        id: item.id,
        attachmentPayload: item.attachmentPayload,
      });
      expect(cleanup).not.toHaveBeenCalled();

      consumedRunId = item.sendRunId;
      history.resolve(consumedHistory());
      await loadChatHistory(visible);

      expect(listStoredChatOutboxes(visible)).toStrictEqual([]);
      expect(cleanup).toHaveBeenCalledWith([item.attachmentPayload]);
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    } finally {
      hydration.resolve();
      history.resolve(idleChatHistory(sessionKey));
      await Promise.all(pendingRetirements);
      await Promise.all(pendingReads);
      stopInactive();
      stopVisible();
      stopSource();
    }
  });
});

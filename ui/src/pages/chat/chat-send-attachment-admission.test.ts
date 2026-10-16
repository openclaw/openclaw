// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as outboxPayloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  readStoredOutboxStore,
  storageTargetForComposer,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  createDeliveryAttachmentBatch,
  createStagedAttachment,
} from "./chat-delivery-attachments.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";

useChatSendBrowserFixture();

describe("chat attachment admission", () => {
  it.each(["same owner", "connection", "recovery owner", "selected agent"])(
    "settles overlapping attachment admissions with %s",
    async (changedOwner) => {
      const { attachments, dataUrls } = createDeliveryAttachmentBatch();
      const host = makeChatHost({
        requestHandlers: {},
        connected: false,
        chatMessage: "Stale submission",
        chatAttachments: attachments,
      });
      if (changedOwner === "selected agent") {
        host.sessionKey = "global";
        host.assistantAgentId = "main";
        host.agentsList = { defaultId: "main", mainKey: "main", scope: "global" };
      }
      const entered = [createDeferred(), createDeferred()];
      const releases = [createDeferred(), createDeferred()];
      let writes = 0;
      const writePayload = outboxPayloadStore.writeOutboxPayload;
      vi.spyOn(outboxPayloadStore, "writeOutboxPayload").mockImplementation(async (...args) => {
        const index = writes++;
        entered[index]?.resolve();
        await releases[index]?.promise;
        return writePayload(...args);
      });
      const stale = handleSendChat(host);
      let current: ReturnType<typeof handleSendChat> | undefined;
      try {
        await Promise.race([
          entered[0]!.promise,
          stale.then(() => {
            throw new Error("Stale submission ended before payload write");
          }),
        ]);
        if (changedOwner === "connection") {
          host.connectionEpoch = (host.connectionEpoch ?? 0) + 1;
        } else if (changedOwner === "selected agent") {
          host.assistantAgentId = "other";
        } else if (changedOwner === "recovery owner") {
          vi.spyOn(expectDefined(host.client, "client"), "recoveryScope", "get").mockReturnValue(
            "new-synthetic-principal",
          );
        }
        host.chatMessage = "Current submission";
        current = handleSendChat(host);
        await Promise.race([
          entered[1]!.promise,
          current.then(() => {
            throw new Error("Current submission ended before payload write");
          }),
        ]);
        if (changedOwner !== "same owner") {
          host.chatMessage = "Newer draft";
          releases[1]!.resolve();
          await current;
          expect(host.chatMessage).toBe("Newer draft");
          expect(host.chatAttachments).toEqual([]);
        }
      } finally {
        releases.forEach((release) => release.resolve());
        await Promise.all([stale, current]);
      }
      const queued = listStoredChatOutboxes(host)[0]?.queue ?? [];
      expect(queued.map((item) => item.text)).toEqual(
        changedOwner === "same owner"
          ? ["Stale submission", "Current submission"]
          : ["Current submission"],
      );
      expect(host.chatMessage).toBe(changedOwner === "same owner" ? "" : "Newer draft");
      expect(host.chatAttachments).toEqual([]);
      const hydrated = await prepareOutboxPayload(
        host,
        expectDefined(queued.at(-1), "current input"),
      );
      expect(
        hydrated.status === "ready"
          ? hydrated.update.attachments?.map(getChatAttachmentDataUrl)
          : [],
      ).toEqual(dataUrls);
      expect(host.request).not.toHaveBeenCalled();
    },
  );

  it.each(["committed", "payload failure", "metadata failure", "unrelated send"])(
    "preserves a newer draft while settling submitted attachment ownership (%s)",
    async (outcome) => {
      const { attachments, dataUrls } = createDeliveryAttachmentBatch();
      const added = createStagedAttachment("newer-draft-file");
      const replacement = { ...attachments[1]!, fileName: "replacement.pdf" };
      const newerReply = { messageId: "newer-quote", text: "Newer quote" };
      const newerMentions = [{ profileId: "alex", start: 0, end: 5 }];
      const olderStarted = createDeferred();
      const olderAck = createDeferred<{ runId: string; status: string }>();
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": () => {
            olderStarted.resolve();
            return olderAck.promise;
          },
        },
        connected: false,
        chatMessage: "First prompt",
        chatAttachments: attachments,
      });
      if (outcome === "unrelated send") {
        host.connected = true;
        host.chatMessage = "Older text-only send";
        host.chatAttachments = [];
        const older = handleSendChat(host);
        onTestFinished(async () => {
          olderAck.resolve({ runId: "older-run", status: "started" });
          await older;
        });
        await Promise.race([
          olderStarted.promise,
          older.then(() => {
            throw new Error("Older send ended before transport");
          }),
        ]);
        host.chatMessage = "First prompt";
        host.chatAttachments = attachments;
      }
      const started = createDeferred();
      const release = createDeferred();
      const writePayload = outboxPayloadStore.writeOutboxPayload;
      vi.spyOn(outboxPayloadStore, "writeOutboxPayload").mockImplementationOnce(async (...args) => {
        started.resolve();
        await release.promise;
        return outcome === "payload failure"
          ? { status: "failed", reason: "unavailable" }
          : writePayload(...args);
      });
      const sending = handleSendChat(host);
      try {
        await Promise.race([
          started.promise,
          sending.then(() => {
            throw new Error("Submission ended before payload write");
          }),
        ]);
        host.chatMessage = "@Alex newer input";
        host.chatMentions = newerMentions;
        host.chatReplyTarget = newerReply;
        host.chatAttachments = [attachments[0]!, replacement, added];
        expect(
          listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue.map((item) => item.text)),
        ).toEqual(outcome === "unrelated send" ? ["Older text-only send"] : []);
        expect(host.chatAttachments.map(getChatAttachmentDataUrl)).toEqual([
          ...dataUrls,
          getChatAttachmentDataUrl(added),
        ]);
        if (outcome === "metadata failure") {
          const write = sessionStorage.setItem.bind(sessionStorage);
          const target = storageTargetForComposer(host);
          vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
            if (key === target.key) {
              throw new DOMException("quota exceeded", "QuotaExceededError");
            }
            write(key, value);
          });
        }
      } finally {
        release.resolve();
        await sending;
      }
      expect(host.chatMessage).toBe("@Alex newer input");
      expect(host.chatMentions).toEqual(newerMentions);
      expect(host.chatReplyTarget).toEqual(newerReply);
      expect(host.request).toHaveBeenCalledTimes(outcome === "unrelated send" ? 1 : 0);
      if (outcome === "payload failure" || outcome === "metadata failure") {
        expect(host.chatAttachments).toEqual([attachments[0], replacement, added]);
        expect(listStoredChatOutboxes(host)).toEqual([]);
        return;
      }
      expect(host.chatAttachments).toEqual([replacement, added]);
      const first = expectDefined(
        listStoredChatOutboxes(host)[0]?.queue.find((item) => item.text === "First prompt"),
        "first submission",
      );
      const hydrated = await prepareOutboxPayload(host, first);
      expect(
        hydrated.status === "ready"
          ? hydrated.update.attachments?.map(getChatAttachmentDataUrl)
          : [],
      ).toEqual(dataUrls);
      await handleSendChat(host);
      const queue =
        listStoredChatOutboxes(host)[0]?.queue.filter(
          (item) => item.text !== "Older text-only send",
        ) ?? [];
      expect(queue.map((item) => item.id)).toEqual([first.id, expect.any(String)]);
      expect(queue[1]?.id).not.toBe(first.id);
      expect(queue[1]?.text).toContain("@Alex newer input");
      expect(queue[1]?.attachments?.map((attachment) => attachment.id)).toEqual([
        replacement.id,
        added.id,
      ]);
    },
  );

  it.each(["defaults", "route", "recovery owner", "reply"])(
    "keeps the creation-time destination and input while payload admission awaits changed %s",
    async (change) => {
      const { attachments, dataUrls } = createDeliveryAttachmentBatch();
      const replyTarget = {
        messageId: "original-quote",
        sourceMessageId: "original-entry",
        text: "Original quote",
      };
      const newerReply = { messageId: "newer-quote", text: "Newer quote" };
      const host = makeChatHost({
        requestHandlers: {},
        connected: false,
        sessionKey: "main",
        agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
        chatMessage: "original destination",
        chatAttachments: attachments,
        chatReplyTarget: replyTarget,
      });
      const started = createDeferred();
      const release = createDeferred();
      const writePayload = outboxPayloadStore.writeOutboxPayload;
      vi.spyOn(outboxPayloadStore, "writeOutboxPayload").mockImplementationOnce(async (...args) => {
        started.resolve();
        await release.promise;
        return writePayload(...args);
      });
      const sending = handleSendChat(host);
      try {
        await Promise.race([
          started.promise,
          sending.then(() => {
            throw new Error("Submission ended before payload write");
          }),
        ]);
        if (change === "defaults") {
          host.agentsList = { defaultId: "main", mainKey: "current", scope: "per-sender" };
        } else if (change === "route") {
          host.sessionKey = "agent:main:elsewhere";
        } else if (change === "recovery owner") {
          vi.spyOn(
            expectDefined(host.client, "payload client"),
            "recoveryScope",
            "get",
          ).mockReturnValue("different-owner");
        } else {
          host.chatReplyTarget = newerReply;
        }
        if (change !== "reply") {
          host.chatMessage = "newer input";
        }
      } finally {
        release.resolve();
        await sending;
      }
      const expectedDraft = change === "reply" ? "original destination" : "newer input";
      expect(host.chatMessage).toBe(expectedDraft);
      expect(host.chatReplyTarget).toEqual(change === "reply" ? newerReply : replyTarget);
      expect(host.request).not.toHaveBeenCalled();
      if (change !== "defaults" && change !== "reply") {
        expect(listStoredChatOutboxes(host)).toEqual([]);
        expect(host.chatAttachments.map(getChatAttachmentDataUrl)).toEqual(dataUrls);
        return;
      }
      const stored = expectDefined(listStoredChatOutboxes(host)[0], "captured outbox");
      expect(stored).toMatchObject({ sessionKey: "agent:main:main", agentId: "main" });
      expect(stored.queue[0]).toMatchObject({
        sessionKey: "agent:main:main",
        sendAttempts: 0,
        replyToId: "original-entry",
      });
      const hydrated = await prepareOutboxPayload(
        host,
        expectDefined(stored.queue[0], "stored input"),
      );
      expect(
        hydrated.status === "ready"
          ? hydrated.update.attachments?.map(getChatAttachmentDataUrl)
          : [],
      ).toEqual(dataUrls);
      expect(host.chatMessage).toBe(expectedDraft);
      expect(host.chatAttachments).toEqual(change === "defaults" ? attachments : []);
      expect(host.request).not.toHaveBeenCalled();
    },
  );

  it("keeps a verified Blob admission when its notification changes recovery owner", async () => {
    const { attachments, dataUrls } = createDeliveryAttachmentBatch();
    const host = makeChatHost({
      requestHandlers: {},
      connected: false,
      chatMessage: "committed input",
      chatAttachments: attachments,
    });
    const client = expectDefined(host.client, "recovery client");
    const target = storageTargetForComposer(host);
    const recovery = vi.spyOn(client, "recoveryScope", "get");
    const originalRecovery = client.recoveryScope;
    const cleanup = vi.spyOn(outboxPayloadStore, "removeOutboxPayloads");
    const stop = subscribeStoredChatOutboxChanges(() => {
      recovery.mockReturnValue("new-synthetic-principal");
      host.chatMessage = "newer input";
    });
    try {
      await handleSendChat(host);
    } finally {
      stop();
    }
    const raw = readStoredOutboxStore(sessionStorage, target);
    const queued = expectDefined(
      Object.values(raw.sessions).flatMap((session) => session.queue ?? [])[0],
      "verified committed input",
    );
    expect(queued).toMatchObject({ text: "committed input", sendAttempts: 0 });
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(cleanup).not.toHaveBeenCalled();
    recovery.mockReturnValue(originalRecovery);
    const hydrated = await prepareOutboxPayload(host, queued);
    expect(
      hydrated.status === "ready" ? hydrated.update.attachments?.map(getChatAttachmentDataUrl) : [],
    ).toEqual(dataUrls);
    expect(host.chatMessage).toBe("newer input");
    expect(host.request).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
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

function admissionFixture(
  chatMessage: string,
  overrides: NonNullable<Parameters<typeof makeChatHost>[0]> = {},
) {
  const batch = createDeliveryAttachmentBatch();
  const host = makeChatHost({
    connected: false,
    chatMessage,
    chatAttachments: batch.attachments,
    ...overrides,
    requestHandlers: overrides.requestHandlers ?? {},
  });
  return { ...batch, host };
}

async function enteredBeforeSettling(entered: Promise<unknown>, sending: Promise<unknown>) {
  await Promise.race([
    entered,
    sending.then(() => {
      throw new Error("Submission ended before payload write");
    }),
  ]);
}

const writePayload = outboxPayloadStore.writeOutboxPayload;
function holdPayloadWrite(fail = false) {
  const entered = createDeferred();
  const release = createDeferred();
  vi.spyOn(outboxPayloadStore, "writeOutboxPayload").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return fail ? { status: "failed", reason: "unavailable" } : writePayload(...args);
  });
  return { entered, release };
}

async function duringAdmission(
  host: ReturnType<typeof makeChatHost>,
  fail: boolean,
  change: () => void,
) {
  const gate = holdPayloadWrite(fail);
  const sending = handleSendChat(host);
  try {
    await enteredBeforeSettling(gate.entered.promise, sending);
    change();
  } finally {
    gate.release.resolve();
    await sending;
  }
}

async function expectPayload(
  host: ReturnType<typeof makeChatHost>,
  item: Parameters<typeof prepareOutboxPayload>[1] | undefined,
  dataUrls: string[],
) {
  const hydrated = await prepareOutboxPayload(host, expectDefined(item, "stored input"));
  expect(
    hydrated.status === "ready" ? hydrated.update.attachments?.map(getChatAttachmentDataUrl) : [],
  ).toEqual(dataUrls);
}

it.each(["same owner", "connection", "recovery owner", "selected agent"])(
  "settles overlapping attachment admissions with %s",
  async (changedOwner) => {
    const { host, dataUrls } = admissionFixture("Stale submission");
    if (changedOwner === "selected agent") {
      host.sessionKey = "global";
      host.assistantAgentId = "main";
      host.agentsList = { defaultId: "main", mainKey: "main", scope: "global" };
    }
    const firstGate = holdPayloadWrite();
    const secondGate = holdPayloadWrite();
    const stale = handleSendChat(host);
    let current: ReturnType<typeof handleSendChat> | undefined;
    try {
      await enteredBeforeSettling(firstGate.entered.promise, stale);
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
      await enteredBeforeSettling(secondGate.entered.promise, current);
      if (changedOwner !== "same owner") {
        host.chatMessage = "Newer draft";
        secondGate.release.resolve();
        await current;
        expect(host).toMatchObject({ chatMessage: "Newer draft", chatAttachments: [] });
      }
    } finally {
      firstGate.release.resolve();
      secondGate.release.resolve();
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
    await expectPayload(host, queued.at(-1), dataUrls);
    expect(host.request).not.toHaveBeenCalled();
  },
);

it.each(["committed", "payload failure", "metadata failure", "unrelated send"])(
  "preserves a newer draft while settling submitted attachment ownership (%s)",
  async (outcome) => {
    const olderStarted = createDeferred();
    const olderAck = createDeferred<{ runId: string; status: string }>();
    const { host, attachments, dataUrls } = admissionFixture("First prompt", {
      requestHandlers: {
        "chat.send": () => {
          olderStarted.resolve();
          return olderAck.promise;
        },
      },
    });
    const added = createStagedAttachment("newer-draft-file");
    const replacement = { ...attachments[1]!, fileName: "replacement.pdf" };
    const newerReply = { messageId: "newer-quote", text: "Newer quote" };
    const newerMentions = [{ profileId: "alex", start: 0, end: 5 }];
    if (outcome === "unrelated send") {
      host.connected = true;
      host.chatMessage = "Older text-only send";
      host.chatAttachments = [];
      const older = handleSendChat(host);
      onTestFinished(async () => {
        olderAck.resolve({ runId: "older-run", status: "started" });
        await older;
      });
      await enteredBeforeSettling(olderStarted.promise, older);
      host.chatMessage = "First prompt";
      host.chatAttachments = attachments;
    }
    await duringAdmission(host, outcome === "payload failure", () => {
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
    });
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
    await expectPayload(host, first, dataUrls);
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
    const replyTarget = {
      messageId: "original-quote",
      sourceMessageId: "original-entry",
      text: "Original quote",
    };
    const newerReply = { messageId: "newer-quote", text: "Newer quote" };
    const { host, attachments, dataUrls } = admissionFixture("original destination", {
      sessionKey: "main",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
      chatReplyTarget: replyTarget,
    });
    await duringAdmission(host, false, () => {
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
    });
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
    await expectPayload(host, stored.queue[0], dataUrls);
    expect(host.chatMessage).toBe(expectedDraft);
    expect(host.chatAttachments).toEqual(change === "defaults" ? attachments : []);
    expect(host.request).not.toHaveBeenCalled();
  },
);

it("keeps a verified Blob admission when its notification changes recovery owner", async () => {
  const { host, dataUrls } = admissionFixture("committed input");
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
  await expectPayload(host, queued, dataUrls);
  expect(host.chatMessage).toBe("newer input");
  expect(host.request).not.toHaveBeenCalled();
});

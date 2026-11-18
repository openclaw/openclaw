/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { IDBObjectStore } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  openControlUiDatabase,
  requestResult,
} from "../../lib/chat/control-ui-database.runtime.ts";
import * as payloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";

useChatSendBrowserFixture();

it("refuses attachment storage without ready recovery admission", async () => {
  const host = makeChatHost({ requestHandlers: {} });
  vi.spyOn(expectDefined(host.client, "client"), "recoveryScopeReady", "get").mockReturnValue(
    false,
  );
  expect(
    await prepareOutboxPayload(host, {
      id: "private-queue-id",
      text: "private body",
      createdAt: 1,
      attachments: [createStagedAttachment("private-file")],
    }),
  ).toEqual({ status: "failed", reason: "unavailable" });
});

it("refuses attachment storage after recovery admission is retired", async () => {
  const host = makeChatHost({ requestHandlers: {} });
  vi.spyOn(expectDefined(host.client, "client"), "offlineRecoveryRetired", "get").mockReturnValue(
    true,
  );
  expect(
    await prepareOutboxPayload(host, {
      id: "private-id",
      text: "private body",
      createdAt: 1,
      attachments: [createStagedAttachment("private-file")],
    }),
  ).toEqual({ status: "failed", reason: "unavailable" });
});

it.each(["tab-storage-access", "tab-storage-read", "tab-lock-claim", "tab-storage-write"] as const)(
  "preserves the original tab rejection at %s",
  async (stage) => {
    const error = new DOMException("private error message", "SecurityError");
    if (stage === "tab-storage-access") {
      vi.stubGlobal("sessionStorage", undefined);
    } else if (stage === "tab-lock-claim") {
      vi.spyOn(navigator.locks, "request").mockRejectedValueOnce(error);
    } else {
      vi.spyOn(
        sessionStorage,
        stage === "tab-storage-read" ? "getItem" : "setItem",
      ).mockImplementationOnce(() => {
        throw error;
      });
    }
    const rejected = payloadStore.outboxPayloadTab();
    if (stage === "tab-storage-access") {
      await expect(rejected).rejects.toThrow("Outbox ownership unavailable");
    } else {
      await expect(rejected).rejects.toBe(error);
    }
  },
);

it.each([
  ["idb-open", "Error", "unavailable"],
  ["idb-transaction", "private-error-name", "unavailable"],
  ["idb-get-all", "InvalidStateError", "unavailable"],
  ["idb-add", "DataCloneError", "unavailable"],
  ["idb-transaction", "QuotaExceededError", "capacity"],
] as const)(
  "preserves storage failure at %s with error %s and reason %s",
  async (stage, name, reason) => {
    const error = new DOMException("private error body https://private.invalid/token", name);
    const refuse = () => {
      throw error;
    };
    if (stage === "idb-open") {
      vi.stubGlobal("indexedDB", undefined);
    } else if (stage === "idb-transaction") {
      const database = await openControlUiDatabase();
      vi.spyOn(database, "transaction").mockImplementationOnce(refuse);
    } else {
      vi.spyOn(
        IDBObjectStore.prototype,
        stage === "idb-get-all" ? "getAll" : "add",
      ).mockImplementationOnce(refuse);
    }
    expect(
      await payloadStore.writeOutboxPayload(
        {
          gatewayOwner: "https://private.invalid",
          recoveryScope: "private-scope",
          tabId: "private-tab",
          queueId: "private-id",
        },
        [{ blob: new Blob(["private bytes"]), mimeType: "text/plain", fileName: "private-file" }],
      ),
    ).toEqual({ status: "failed", reason });
  },
);

it.each(["abort", "request-error"] as const)(
  "refuses a real write %s and settles its transaction abort",
  async (mode) => {
    const add = vi.spyOn(IDBObjectStore.prototype, "add");
    let aborted: Promise<void> | undefined;
    add.mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      add.mockRestore();
      const first = this.add(...args);
      // A duplicate real key fails the returned add request, not the completion helper.
      const request = mode === "request-error" ? this.add(...args) : first;
      const transaction = expectDefined(request.transaction, "write transaction");
      aborted = new Promise((resolve) => {
        transaction.addEventListener("abort", () => resolve(), { once: true });
      });
      if (mode !== "request-error") {
        request.addEventListener(
          "success",
          () => {
            transaction.abort();
          },
          { once: true },
        );
      }
      return request;
    });
    expect(
      await payloadStore.writeOutboxPayload(
        {
          gatewayOwner: "fixture",
          recoveryScope: "scope",
          tabId: "tab",
          queueId: "input",
        },
        [{ blob: new Blob(["bytes"]), mimeType: "text/plain" }],
      ),
    ).toEqual({ status: "failed", reason: "unavailable" });
    // Both failure paths must reach the real transaction abort before fixture cleanup.
    await expectDefined(aborted, "real abort observation");
  },
);

it.each(["owner-after-tab", "owner-after-write"] as const)(
  "preserves refusal and cleanup when the owner changes at %s",
  async (stage) => {
    const host = makeChatHost({ requestHandlers: {} });
    if (stage === "owner-after-write") {
      const add = vi.spyOn(IDBObjectStore.prototype, "add");
      add.mockImplementationOnce(function (this: IDBObjectStore, ...args) {
        add.mockRestore();
        host.client = null;
        return this.add(...args);
      });
    }
    const pending = prepareOutboxPayload(host, {
      id: "private-id",
      text: "private body",
      createdAt: 1,
      attachments: [createStagedAttachment("private-file")],
    });
    if (stage === "owner-after-tab") {
      host.client = null;
    }
    expect(await pending).toEqual({ status: "failed", reason: "unavailable" });
    const database = await openControlUiDatabase();
    const request = database.transaction("outboxPayloads").objectStore("outboxPayloads").getAll();
    const remaining = await requestResult(request);
    expect(remaining).toEqual([]);
  },
);

it("keeps a private attachment out of IndexedDB before session metadata arrives", async () => {
  const attachment = createStagedAttachment("private-input");
  const host = makeChatHost({
    sessionKey: "agent:main:dashboard:incognito-missing",
    selectedChatSessionIncognito: false,
    chatMessage: "Private unsent input",
    chatAttachments: [attachment],
    requestHandlers: {
      "chat.send": () => {
        throw new Error("Incognito session was not found");
      },
    },
  });
  const write = vi.spyOn(payloadStore, "writeOutboxPayload");
  await handleSendChat(host);
  expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  expect(write).not.toHaveBeenCalled();
  expect(host.chatQueue[0]).toMatchObject({ text: "Private unsent input", sendState: "failed" });
  expect(host.chatQueue[0]?.attachmentPayload).toBeUndefined();
});

it("admits an ordinary queued attachment while another selected pane is private", async () => {
  const host = makeChatHost({
    requestHandlers: {},
    sessionKey: "agent:main:dashboard:incognito-selected",
    selectedChatSessionIncognito: true,
  });
  const item: ChatQueueItem = {
    id: "ordinary-queued-input",
    text: "Ordinary input",
    createdAt: 1,
    sessionKey: "agent:main:dashboard:ordinary",
    attachments: [createStagedAttachment("ordinary-input")],
  };
  const write = vi.spyOn(payloadStore, "writeOutboxPayload");
  const result = await prepareOutboxPayload(host, item);
  expect(result).toMatchObject({
    status: "ready",
    update: { attachmentPayload: expect.anything() },
  });
  expect(write).toHaveBeenCalledTimes(1);
});

it("copies a duplicated tab's attachment without pausing its original pending submission", async () => {
  const gatewayUrl = "ws://duplicate-outbox.test";
  const host = makeChatHost({ requestHandlers: {}, settings: { gatewayUrl } });
  const recoveryScope = expectDefined(host.client?.recoveryScope, "account recovery scope");
  const blob = new Blob(["copied attachment"], { type: "text/plain" });
  const metadata = { mimeType: blob.type, fileName: "queued.txt", sizeBytes: blob.size };
  const source = await payloadStore.writeOutboxPayload(
    { gatewayOwner: gatewayUrl, recoveryScope, tabId: "source-tab", queueId: "original-input" },
    [{ ...metadata, blob }],
  );
  if (source.status !== "ready") {
    throw new Error("Source attachment was not stored");
  }
  const original: ChatQueueItem = {
    id: "original-input",
    text: "Keep the original submission",
    createdAt: 1,
    sendRunId: "original-run",
    sendAttempts: 1,
    sendState: "waiting-reconnect",
    attachmentPayload: source.value,
    attachments: [{ id: "original-attachment", ...metadata }],
  };

  const result = await prepareOutboxPayload(host, original);

  if (result.status !== "ready") {
    throw new Error("Duplicated attachment was not prepared");
  }
  expect({ ...original, ...result.update }).toMatchObject({
    id: "original-input",
    sendRunId: "original-run",
    sendAttempts: 1,
    sendState: "waiting-reconnect",
    attachments: [{ ...metadata, dataUrl: `data:${blob.type};base64,Y29waWVkIGF0dGFjaG1lbnQ=` }],
  });
  expect(result.update.attachmentPayload?.key).not.toBe(source.value.key);
  expect(result.update.attachmentPayload?.tabId).not.toBe("source-tab");
});

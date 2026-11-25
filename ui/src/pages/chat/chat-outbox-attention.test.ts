/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listChatOutboxAttention } from "../../lib/chat/outbox-attention.ts";
import { createStoredChatOutboxReader } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { loadChatComposerState } from "./composer-draft-storage.ts";
import {
  admitStoredChatComposerQueueItemResult,
  updateStoredChatComposerQueueItems,
} from "./composer-queue-persistence.ts";

const scope = { sessionKey: "agent:writer:review", agentId: "writer" };
function hostFor(recoveryScope = "owner-a") {
  return {
    settings: { gatewayUrl: "ws://outbox-attention.test" },
    client: { recoveryScope, recoveryScopeReady: true },
    connected: true,
    agentsList: { defaultId: "writer", mainKey: "main", scope: "per-sender" },
    sessionKey: scope.sessionKey,
    chatQueue: [] as ChatQueueItem[],
  };
}
function item(id: string, sendState: ChatQueueItem["sendState"]): ChatQueueItem {
  return {
    id,
    text: "Private message must not be copied to Inbox",
    createdAt: 1,
    ...scope,
    sendRunId: `run-${id}`,
    sendState,
  };
}
function admit(host: ReturnType<typeof hostFor>, row: ChatQueueItem) {
  expect(
    admitStoredChatComposerQueueItemResult(
      host,
      captureChatOutboxAdmission(host, host.sessionKey),
      row,
    ),
  ).toBe("admitted");
}
beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("projects only actionable submissions, without message or diagnostic content", () => {
  const host = hostFor();
  for (const state of [
    undefined,
    "waiting-idle",
    "waiting-reconnect",
    "sending",
    "submitting",
    "failed",
    "held",
  ] as const) {
    const row = { ...item(String(state), state), sendError: "private diagnostic" };
    admit(host, row);
  }
  const attention = listChatOutboxAttention(host);
  expect(attention.map((row) => row.id)).toEqual(["failed", "held"]);
  expect(JSON.stringify(attention)).not.toMatch(/Private message|private diagnostic/);
  expect(attention[1]).toMatchObject({ held: true, command: false, ...scope });
  expect(listChatOutboxAttention({ ...host, settings: { gatewayUrl: "ws://other.test" } })).toEqual(
    [],
  );
});

it.each(["selected", "background"])(
  "keeps attention aligned with live delivery in the %s pane",
  (pane) => {
    const host = hostFor();
    const reader = createStoredChatOutboxReader();
    let summary = reader.read(host);
    const stopReader = reader.subscribe(() => {
      summary = reader.read(host);
    });
    const owner = chatOutboxOwner(host);
    const stop = owner.subscribe(host);
    const other = { ...host, chatQueue: [] as ChatQueueItem[] };
    const stopOther = owner.subscribe(other);
    const sender = pane === "selected" ? host : other;
    const expectAttention = (ids: string[]) => {
      expect(listChatOutboxAttention(host).map((entry) => entry.id)).toEqual(ids);
      expect(summary.attentionCountForSession(scope.sessionKey)).toBe(ids.length);
      expect(summary.sessions).toEqual(
        ids.length ? [{ ...scope, hasComposerDraft: false, outboxAttentionCount: ids.length }] : [],
      );
    };
    const setDelivery = (id: string, sendState: ChatQueueItem["sendState"]) =>
      owner.update(sender, [{ id, update: (current) => ({ ...current, sendState }) }]);
    try {
      const row = item("settings", "waiting-model");
      expect(owner.admit(sender, captureChatOutboxAdmission(sender, scope.sessionKey), row)).toBe(
        "admitted",
      );
      if (pane === "background") {
        sender.sessionKey = "agent:writer:other";
        owner.syncHost(sender);
      }
      expectAttention([]);
      setDelivery(row.id, "failed");
      expectAttention([row.id]);
      setDelivery(row.id, "executing-command");
      expectAttention([]);
      expect(createStoredChatOutboxReader().read(hostFor("owner-b")).sessions).toEqual([]);
      expect(owner.remove(sender, row.id)).not.toBeNull();
      expect(summary.total).toBe(0);
    } finally {
      stop();
      stopOther();
      stopReader();
    }
  },
);

it("retains incidents through failed removal and clears them only after canonical retirement", () => {
  const host = hostFor();
  admit(host, item("review", "failed"));
  const row = loadChatComposerState(host, host.sessionKey).snapshot!.queue[0]!;
  expect(listChatOutboxAttention(host)).toHaveLength(1);
  const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const remove = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  const retire = () =>
    updateStoredChatComposerQueueItems(host, scope.sessionKey, [{ expected: row, next: null }]);
  expect(retire()).toBe(false);
  expect(listChatOutboxAttention(host)).toHaveLength(1);
  write.mockRestore();
  remove.mockRestore();
  expect(retire()).toBe(true);
  expect(listChatOutboxAttention(host)).toEqual([]);
});

it("preserves existing attachment ownership and remembered offline access without claiming text isolation", () => {
  const host = hostFor();
  const attachment = {
    ...item("attachment", "failed"),
    attachmentPayload: { key: "payload-a", tabId: "tab-a", recoveryScope: "owner-a" },
    attachments: [{ id: "file", mimeType: "text/plain", fileName: "private.txt" }],
  };
  admit(host, attachment);
  expect(listChatOutboxAttention(host)).toHaveLength(1);
  host.connected = false;
  host.client.recoveryScopeReady = false;
  expect(listChatOutboxAttention(host)).toHaveLength(1);
  expect(listChatOutboxAttention(hostFor("owner-b"))).toEqual([]);
  expect(listChatOutboxAttention({ ...host, client: null })).toEqual([]);
  host.connected = true;
  expect(listChatOutboxAttention(host)).toEqual([]);
});

/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatOutboxOwner, listChatOutboxAttention } from "./chat-outbox-owner.ts";
import {
  admitStoredChatComposerQueueItem,
  removeStoredChatComposerQueueItem,
} from "./composer-persistence.ts";

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
    "unconfirmed",
    "held",
  ] as const) {
    const row = { ...item(String(state), state), sendError: "private diagnostic" };
    expect(
      admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, host.sessionKey),
        row,
      ),
    ).toBe(true);
  }
  const attention = listChatOutboxAttention(host);
  expect(attention.map((row) => row.id)).toEqual(["failed", "unconfirmed", "held"]);
  expect(JSON.stringify(attention)).not.toMatch(/Private message|private diagnostic/);
  expect(attention[1]).toMatchObject({ unconfirmed: true, command: false, ...scope });
  expect(listChatOutboxAttention({ ...host, settings: { gatewayUrl: "ws://other.test" } })).toEqual(
    [],
  );
});

it("does not mistake an active settings wait or send overlay for a failed message", () => {
  const host = hostFor();
  const owner = chatOutboxOwner(host);
  const stop = owner.subscribe(host);
  try {
    const row = item("settings", "waiting-model");
    expect(owner.admit(host, captureChatOutboxAdmission(host, host.sessionKey), row)).toBe(
      "admitted",
    );
    expect(listChatOutboxAttention(host)).toEqual([]);
    owner.update(host, [
      { id: row.id, update: (current) => ({ ...current, sendState: "failed" }) },
    ]);
    expect(listChatOutboxAttention(host).map((entry) => entry.id)).toEqual([row.id]);
    owner.update(host, [
      { id: row.id, update: (current) => ({ ...current, sendState: "sending" }) },
    ]);
    expect(listChatOutboxAttention(host)).toEqual([]);
  } finally {
    stop();
  }
});

it("retains incidents through failed removal and clears them only after canonical retirement", () => {
  const host = hostFor();
  const row = item("review", "unconfirmed");
  admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, host.sessionKey), row);
  expect(listChatOutboxAttention(host)).toHaveLength(1);
  const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const remove = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(removeStoredChatComposerQueueItem(host, scope.sessionKey, row.id, row)).toBe(false);
  expect(listChatOutboxAttention(host)).toHaveLength(1);
  write.mockRestore();
  remove.mockRestore();
  expect(removeStoredChatComposerQueueItem(host, scope.sessionKey, row.id, row)).toBe(true);
  expect(listChatOutboxAttention(host)).toEqual([]);
});

it("preserves existing attachment ownership and remembered offline access without claiming text isolation", () => {
  const host = hostFor();
  const attachment = {
    ...item("attachment", "unconfirmed"),
    attachmentPayload: { key: "payload-a", tabId: "tab-a", recoveryScope: "owner-a" },
    attachments: [{ id: "file", mimeType: "text/plain", fileName: "private.txt" }],
  };
  admitStoredChatComposerQueueItem(
    host,
    captureChatOutboxAdmission(host, host.sessionKey),
    attachment,
  );
  expect(listChatOutboxAttention(host)).toHaveLength(1);
  host.connected = false;
  host.client.recoveryScopeReady = false;
  expect(listChatOutboxAttention(host)).toHaveLength(1);
  expect(listChatOutboxAttention(hostFor("owner-b"))).toEqual([]);
  expect(listChatOutboxAttention({ ...host, client: null })).toEqual([]);
  host.connected = true;
  expect(listChatOutboxAttention(host)).toEqual([]);
});

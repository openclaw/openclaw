/* @vitest-environment jsdom */
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import * as drafts from "../../lib/chat/composer-draft-store.runtime.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { restorePaneStagedAttachments } from "./chat-pane-attachment-handoff.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import {
  admitStoredChatComposerQueueItem,
  ChatComposerPersistence,
  loadChatComposerState,
} from "./composer-persistence.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps A offline input with A when a same-client B hello replaces the pane before recovery settles", async () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.spyOn(drafts, "prepareDurableComposerRecovery").mockResolvedValue({
    status: "ready",
    entries: [],
  });
  vi.spyOn(drafts, "readDurableComposerDraft").mockResolvedValue({
    status: "not-found",
    revision: 0,
  });
  const write = vi
    .spyOn(drafts, "writeDurableComposerDraft")
    .mockResolvedValue({ status: "persisted" });
  let account = "account-a";
  let ready = false;
  const client = createTestGatewayClient(async () => ({}));
  vi.spyOn(client, "recoveryScope", "get").mockImplementation(() => account);
  vi.spyOn(client, "offlineRecoveryScope", "get").mockImplementation(() => account);
  vi.spyOn(client, "recoveryScopeReady", "get").mockImplementation(() => ready);
  const { pane, state } = createTestChatPane({ client });
  const context = pane.context;
  Object.assign(pane, { paneId: "p1", stagedAttachmentGatewayOwner: client });
  Object.assign(state, {
    settings: context.gateway.connection,
    chatMessage: "A offline draft",
    selectedChatSessionIncognito: false,
    connected: false,
  });
  pane.chatState.attach(state);
  const persistence = pane.chatState.composerPersistence;
  persistence.start();
  await settle();
  ready = true;
  state.connected = true;
  persistence.persistChangedState();
  ready = false;
  state.connected = false;
  expect(
    admitStoredChatComposerQueueItem(state, captureChatOutboxAdmission(state, state.sessionKey), {
      id: "a-queue",
      text: "A queued work",
      createdAt: 1,
    }),
  ).toBe(true);
  const attachment: ChatAttachment = {
    id: "a-attachment",
    mimeType: "text/plain",
    dataUrl: "data:text/plain;base64,QQ==",
    fileName: "a-only.txt",
  };
  state.chatMessage = "A newer private draft";
  state.chatAttachments = [attachment];
  persistence.schedule();
  persistence.persistNow();
  await settle();
  const original = loadChatComposerState(state, state.sessionKey).snapshot;
  expect(original?.draft).toBe("A newer private draft");
  // GatewayBrowserClient replaces identity before notifying hello observers. The
  // route can unmount the A pane before its persistence sees recovery readiness.
  account = "account-b";
  context.gateway.snapshot.hello = {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [], recoveryScope: account },
  };
  pane.disconnectedCallback();
  ready = true;
  const destination = {
    ...state,
    client,
    connected: true,
    chatMessage: "",
    chatAttachments: [] as ChatAttachment[],
    chatQueue: [],
  };
  restorePaneStagedAttachments(context, "p1", destination, client);
  const b = new ChatComposerPersistence(() => destination);
  b.start();
  b.persistChangedState();
  await settle();
  expect(destination.chatMessage).toBe("");
  expect(destination.chatAttachments).toEqual([]);
  expect(loadChatComposerState(destination, destination.sessionKey).snapshot?.draft ?? "").toBe("");
  expect(
    write.mock.calls
      .filter(([scope]) => scope.recoveryScope === "account-b")
      .some(([, draft]) => draft.text.includes("A newer") || draft.attachments.length),
  ).toBe(false);
  account = "account-a";
  expect(loadChatComposerState(destination, destination.sessionKey).snapshot).toMatchObject({
    draft: "A newer private draft",
    queue: [{ id: "a-queue" }],
  });
  expect(
    write.mock.calls.some(
      ([scope, draft]) =>
        scope.recoveryScope === "account-a" &&
        draft.text === "A newer private draft" &&
        draft.attachments.length === 1,
    ),
  ).toBe(true);
  b.stop();
});

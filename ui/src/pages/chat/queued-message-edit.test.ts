/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentsListResult } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes as listOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission as captureAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl as attachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
  renderComposerInto,
  disposeComposer,
} from "./chat-composer.test-support.ts";
import { applyChatAgentsList } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession as admitForSession } from "./chat-outbox-admission.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import { updateQueuedMessage } from "./chat-queue.ts";
import {
  moveQueuedChatMessage as moveQueued,
  retryQueuedChatMessage as retryQueued,
  steerQueuedChatMessage as steerQueued,
} from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import {
  activeQueuedMessageEdit as activeEdit,
  beginQueuedMessageEdit as beginEdit,
  cancelQueuedMessageEdit as cancelEdit,
  isQueuedMessageBeingEdited as isEditing,
  QUEUED_MESSAGE_REORDER_CONFLICT_ERROR,
  updateQueuedMessageEdit as updateEdit,
} from "./queued-message-edit.ts";

const SESSION_KEY = "agent:main:main";
const offline = { sessionKey: SESSION_KEY, connected: false, requestHandlers: {} };
type Host = ReturnType<typeof makeChatHost>;
type HostOptions = Parameters<typeof makeChatHost>[0];
type ProjectionHost = Parameters<ReturnType<typeof chatOutboxOwner>["subscribe"]>[0];
const outboxSubscriptions: Array<() => void> = [];
const stagedAttachments: ChatAttachment[] = [];

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  for (const unsubscribe of outboxSubscriptions.splice(0)) {
    unsubscribe();
  }
  releaseChatAttachmentPayloads(stagedAttachments.splice(0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function trackOutboxProjection(host: ProjectionHost) {
  const unsubscribe = chatOutboxOwner(host).subscribe(host);
  outboxSubscriptions.push(unsubscribe);
  return unsubscribe;
}

function queueHost(items: readonly Partial<ChatQueueItem>[], overrides: HostOptions = {}) {
  const host = makeChatHost({ ...offline, ...overrides });
  const unsubscribe = trackOutboxProjection(host as never);
  items.forEach((item, index) => {
    expect(
      admitForSession(host as never, captureAdmission(host, host.sessionKey, item.agentId), {
        id: `queued-${index + 1}`,
        text: `message ${index + 1}`,
        createdAt: 1_000 + index,
        sendState: "waiting-reconnect",
        sessionKey: host.sessionKey,
        ...item,
      }),
    ).toBe(true);
  });
  return { host, unsubscribe };
}

function sendFixture(items: readonly Partial<ChatQueueItem>[], overrides: HostOptions = {}) {
  const sendRequest = vi.fn(() => ({ status: "started" as const }));
  const { host } = queueHost(items, {
    connected: true,
    ...overrides,
    requestHandlers: { "chat.send": sendRequest, ...overrides.requestHandlers },
  });
  return { host, sendRequest };
}
function peerFor(host: Host) {
  const peer = makeChatHost({ ...offline, client: host.client });
  trackOutboxProjection(peer as never);
  return peer;
}
function storedOrder(host: unknown): string[] {
  return listOutboxes(host as never).flatMap(({ queue }) => queue.map((item) => item.text));
}

function startEdit(host: Host, id: string, text: string) {
  beginEdit(host, id);
  updateEdit(host, text);
}
function historyRefreshFixture() {
  const history = createDeferred<{ messages: unknown[] }>();
  const historyRequest = vi.fn(() => history.promise);
  const { host, sendRequest } = sendFixture([{}], {
    chatLoading: true,
    currentSessionId: "queued-edit-session",
    requestHandlers: { "chat.history": historyRequest },
  });
  startEdit(host, "queued-1", "message 1, corrected");
  return { history, historyRequest, sendRequest, host };
}
async function submitQueuedEdit(host: Host): Promise<void> {
  const edit = host.chatQueuedEdit!;
  await handleSendChat(host as never, edit.draftText, {
    attachmentsOverride: [...edit.attachments],
    resumeQueuedMessageEditId: edit.id,
  });
}

it("saves an unsent queued edit after the connection drops", async () => {
  const { host } = queueHost([
    { sendState: "waiting-idle", sendRunId: "queued-run", sendAttempts: 0 },
  ]);
  startEdit(host, "queued-1", "corrected while reconnecting");

  markQueuedChatSendsWaitingForReconnect(host);
  await submitQueuedEdit(host);

  expect(storedOrder(host)).toEqual(["corrected while reconnecting"]);
  expect(host).toMatchObject({ chatQueuedEdit: null, chatError: null });
});

it.each(["corrected prompt", "/review-this"])("keeps order and context: %s", async (draft) => {
  const workContext = { page: "chat", title: "Original work" };
  const { host } = queueHost([{}, { workContext }, {}], {
    getWorkContext: () => ({ page: "chat", title: "Later work" }),
  });
  startEdit(host, "queued-2", draft);
  await submitQueuedEdit(host);
  expect(storedOrder(host)).toEqual(["message 1", draft, "message 3"]);
  expect(host.chatQueue[1]?.workContext).toEqual(
    draft === "corrected prompt" ? workContext : undefined,
  );
  expect(isEditing(host, "queued-2")).toBe(false);
});

it("keeps explicit queued edits ordered under interrupt defaults", async () => {
  const { host, sendRequest } = sendFixture(
    Array.from({ length: 3 }, () => ({ sendState: "waiting-idle" as const })),
    {
      chatRunId: "run-active",
      chatFollowUpMode: "interrupt",
      requestHandlers: {
        "chat.history": { messages: [], sessionInfo: { key: SESSION_KEY, hasActiveRun: false } },
      },
    },
  );
  moveQueued(host, "queued-3", "queued-2");
  host.chatMessage = "independent composer draft";
  expect(beginEdit(host, "queued-2")).toBe("started");
  updateEdit(host, "message 2, corrected");

  await submitQueuedEdit(host);

  expect(sendRequest).not.toHaveBeenCalled();
  expect(storedOrder(host)).toEqual(["message 1", "message 3", "message 2, corrected"]);
  expect(host).toMatchObject({ chatQueuedEdit: null, chatMessage: "independent composer draft" });
});

it("rejects inline /compact without losing the source row", async () => {
  const command = "/compact";
  const { host, sendRequest } = sendFixture([{}], { chatRunId: "run-active" });
  startEdit(host, "queued-1", command);

  await submitQueuedEdit(host);

  expect(storedOrder(host)).toEqual(["message 1"]);
  expect(host.chatQueuedEdit?.draftText).toBe(command);
  expect(sendRequest).not.toHaveBeenCalled();
  expect(host.chatError).toContain("Queued-row edits cannot run commands or stop aliases");
});

it.each(["move", "remove"])("retains edits after peer %s and navigation", async (mutation) => {
  const { host } = queueHost([{}, {}]);
  startEdit(host, "queued-1", "message 1, corrected");
  const captured = host.chatQueuedEdit?.source;
  host.sessionKey = "agent:main:elsewhere";
  expect(isEditing(host as never, "queued-1")).toBe(false);
  const peer = makeChatHost({ ...offline, client: host.client });
  if (mutation === "remove") {
    chatOutboxOwner(peer).remove(peer as never, "queued-1");
  } else {
    expect(
      updateQueuedMessage(peer as never, "queued-1", (item) => ({
        ...item,
        orderKey: (item.orderKey ?? item.createdAt) + 10,
      })),
    ).not.toBeNull();
  }
  const expectedOrder = mutation === "remove" ? ["message 2"] : ["message 2", "message 1"];

  host.sessionKey = SESSION_KEY;
  await submitQueuedEdit(host);

  expect(host.chatQueuedEdit?.source).toBe(captured);
  expect(storedOrder(host)).toEqual(expectedOrder);
  expect(host.chatQueuedEdit?.draftText).toBe("message 1, corrected");
  expect(host.chatError).toContain("This queued message changed while you were editing.");
  expect(cancelEdit(host as never)).toBe(true);
  expect(storedOrder(host)).toEqual(expectedOrder);
});

it.each(["cancelled", "changed"])("aborts edits %s during refresh", async (change) => {
  const { history, historyRequest, sendRequest, host } = historyRefreshFixture();
  const send = submitQueuedEdit(host);
  await vi.waitFor(() => expect(historyRequest).toHaveBeenCalledOnce());
  if (change === "cancelled") {
    expect(cancelEdit(host as never)).toBe(true);
  } else {
    updateEdit(host as never, "message 1, changed while loading");
  }
  history.resolve({ messages: [] });
  await send;
  expect(storedOrder(host)).toEqual(["message 1"]);
  if (change === "changed") {
    expect(host.chatQueuedEdit?.draftText).toBe("message 1, changed while loading");
  }
  expect(sendRequest).not.toHaveBeenCalled();
});

it("preserves attachments and reply context on the replacement", async () => {
  const kept = registerChatAttachmentPayload({
    attachment: { id: "att-kept", mimeType: "image/png" },
    dataUrl: "data:image/png;base64,cG5n",
    file: new File(["png"], "att-kept.png", { type: "image/png" }),
  });
  stagedAttachments.push(kept);
  const { host } = queueHost([{}, { attachments: [kept], replyToId: "reply-source" }, {}]);
  startEdit(host, "queued-2", "message 2, corrected");
  await submitQueuedEdit(host);

  expect(storedOrder(host)).toEqual(["message 1", "message 2, corrected", "message 3"]);
  expect(isEditing(host as never, "queued-2")).toBe(false);
  const replacement = listOutboxes(host as never)[0]?.queue[1];
  expect(replacement?.attachments?.map((attachment) => attachment.id)).toEqual(["att-kept"]);
  expect(replacement?.replyToId).toBe("reply-source");
  expect(attachmentDataUrl(kept)).not.toBeNull();
});

it("retains the source after a failed replacement write", async () => {
  const { host } = queueHost([{}, {}, {}]);
  startEdit(host, "queued-2", "message 2, corrected");
  const storage = globalThis.sessionStorage;
  const write = storage.setItem.bind(storage);
  vi.spyOn(storage, "setItem").mockImplementation((key: string, value: string) => {
    if (value.length > (storage.getItem(key)?.length ?? 0)) {
      throw new DOMException("exceeded the quota", "QuotaExceededError");
    }
    write(key, value);
  });

  await submitQueuedEdit(host);

  // Keep the original until its replacement is durably stored.
  expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
  expect(isEditing(host as never, "queued-2")).toBe(true);
  expect(host.chatQueuedEdit?.draftText).toBe("message 2, corrected");
  expect(host.chatError).toContain("Your edit could not be saved in this browser.");
  vi.restoreAllMocks();
  await submitQueuedEdit(host);
  expect(storedOrder(host)).toEqual(["message 1", "message 2, corrected", "message 3"]);
  expect(host).toMatchObject({ chatQueuedEdit: null, chatError: null });
});

it("fences peer actions while editing", async () => {
  const original = { id: "queued-1", text: "message 1", createdAt: 1_000 };
  const { host } = queueHost([original]);
  const sendRequest = vi.fn(() => ({ status: "started" as const }));
  const peer = makeChatHost({
    chatQueue: [original],
    chatRunId: "run-active",
    connected: true,
    requestHandlers: { "chat.send": sendRequest },
    sessionKey: SESSION_KEY,
  });
  trackOutboxProjection(peer as never);

  beginEdit(host as never, original.id);

  expect(isEditing(peer as never, original.id)).toBe(true);
  expect(moveQueued(peer as never, original.id, original.id)).toBe("rejected");
  await retryQueued(peer as never, original.id);
  await steerQueued(peer as never, original.id);
  expect(sendRequest).not.toHaveBeenCalled();
  expect(storedOrder(peer)).toEqual(["message 1"]);
});

it("clears reorder conflicts after editing ends", () => {
  const { host } = queueHost([{}, {}, {}]);
  const peer = peerFor(host);

  beginEdit(host as never, "queued-2");

  expect(moveQueued(peer as never, "queued-3", "queued-1")).toBe("rejected");
  expect(peer.chatError).toBe(QUEUED_MESSAGE_REORDER_CONFLICT_ERROR);
  expect(storedOrder(peer)).toEqual(["message 1", "message 2", "message 3"]);
  expect(cancelEdit(host as never)).toBe(true);
  expect(moveQueued(peer as never, "queued-3", "queued-1")).toBe("moved");
  expect(storedOrder(peer)).toEqual(["message 3", "message 1", "message 2"]);
  expect(peer).toMatchObject({ chatError: null, lastError: null });
});

it("preserves unrelated errors after a queue move", () => {
  const { host } = queueHost([{}, {}]);
  host.lastError = "History could not be refreshed";
  host.chatError = OFFLINE_QUEUE_STORAGE_ERROR;

  expect(moveQueued(host as never, "queued-2", "queued-1")).toBe("moved");

  expect(storedOrder(host)).toEqual(["message 2", "message 1"]);
  expect(host).toMatchObject({
    lastError: "History could not be refreshed",
    chatError: OFFLINE_QUEUE_STORAGE_ERROR,
  });
});

it("allows reordering on one side of an edit barrier", () => {
  const { host } = queueHost([{}, {}, {}, {}]);
  const peer = peerFor(host);

  beginEdit(host as never, "queued-2");

  expect(moveQueued(peer as never, "queued-4", "queued-3")).toBe("moved");
  expect(storedOrder(peer)).toEqual(["message 1", "message 2", "message 4", "message 3"]);
});

it("does not collapse same-payload row and composer sends", async () => {
  const ack = createDeferred<{ status: "started" }>();
  const sendRequest = vi.fn(() => ack.promise);
  const requestHandlers = { "chat.send": sendRequest };
  const { host } = queueHost([{}], { connected: true, requestHandlers });
  startEdit(host, "queued-1", "same payload");

  const rowSend = submitQueuedEdit(host);
  await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledOnce());
  host.chatMessage = "same payload";
  const composerSend = handleSendChat(host as never);
  await vi.waitFor(() => expect(host.chatMessage).toBe(""));
  expect(host.chatQueue.map((item) => item.text)).toContain("same payload");

  ack.resolve({ status: "started" });
  await Promise.all([rowSend, composerSend]);
});

it("preserves the prior global agent's queued row", async () => {
  const selected = { assistantAgentId: "lily", sessionKey: "global" };
  const { host } = queueHost([{ agentId: "lily" }], selected);
  expect(beginEdit(host as never, "queued-1")).toBe("started");

  // Global sessions keep their key across agent switches.
  host.assistantAgentId = "nova";
  expect(isEditing(host as never, "queued-1")).toBe(false);

  host.chatMessage = "message 1, corrected";
  await handleSendChat(host as never);

  const byAgent = Object.fromEntries(
    listOutboxes(host).map(({ agentId, sessionKey, queue }) => [
      agentId ?? sessionKey,
      queue.map((item) => item.text),
    ]),
  );
  expect(byAgent).toEqual({ lily: ["message 1"], nova: ["message 1, corrected"] });
});

it("refuses to edit an attempted pending row", () => {
  const { host } = queueHost([{ sendState: "waiting-reconnect", sendAttempts: 1 }]);
  expect(beginEdit(host as never, "queued-1")).toBe("unavailable");
});

it("keeps captured edit custody when main defaults change", async () => {
  const agentsList = makeBootRoster() satisfies AgentsListResult;
  const send = vi.fn(async () => ({ status: "started" }));
  const { host, unsubscribe } = queueHost([{}], {
    connected: true,
    agentsList,
    requestHandlers: { "chat.send": send },
  });
  const container = createComposerContainer();
  try {
    expect(beginEdit(host, "queued-1")).toBe("started");
    expect(updateEdit(host, "Unsaved original correction")).toBe(true);
    const captured = host.chatQueuedEdit!;
    const originalOutboxes = listOutboxes(host);
    applyChatAgentsList(host, { ...agentsList, mainKey: "current" }, host.client!);
    host.sessionKey = "agent:main:current";
    chatOutboxOwner(host).syncHost(host);
    expect(host.chatQueue).toEqual([]);
    const active = activeEdit(host);
    renderComposerInto(
      container,
      createComposerProps({
        queue: host.chatQueue,
        sessionKey: host.sessionKey,
        queuedEdit: {
          editingId: active?.id ?? null,
          editingText: active?.draftText,
          source: active?.source,
          onCancel: () => cancelEdit(host),
        },
      }),
    );
    await submitQueuedEdit(host);
    expect(send).not.toHaveBeenCalled();
    expect(listOutboxes(host)).toEqual(originalOutboxes);
    expect(host.chatQueuedEdit).toBe(captured);
    expect.soft(active).toBeNull();
    expect.soft(container.querySelector(".chat-queue__edit-input")).toBeNull();
    expect.soft(cancelEdit(host)).toBe(false);
    expect.soft(host.chatQueuedEdit).toBe(captured);
    // Returning the real routing facts restores the original owner, not a renamed token.
    applyChatAgentsList(host, agentsList, host.client!);
    host.sessionKey = SESSION_KEY;
    chatOutboxOwner(host).syncHost(host);
    expect(activeEdit(host)?.draftText).toBe("Unsaved original correction");
    expect(cancelEdit(host)).toBe(true);
    expect(listOutboxes(host)).toEqual(originalOutboxes);
  } finally {
    disposeComposer(container);
    unsubscribe();
    await resetComposerFixture();
  }
});

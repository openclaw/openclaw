/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatMessageGetResult,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  discardChatRecoveryInput,
  getChatInputRecovery,
  sendChatRecoveryInput,
  toggleChatRecoveryInput,
  type ChatInputRecoveryHost,
} from "./chat-input-recovery-actions.ts";
import type { ChatInputRecoveryDismissals } from "./chat-input-recovery-contract.ts";
import * as drain from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { makeChatPageHost } from "./chat-pending-inputs.test-support.ts";
import {
  applyChatPendingInputs,
  getChatPendingInputs,
  loadChatPendingInputs,
} from "./chat-pending-inputs.ts";
import * as queue from "./chat-queue.ts";
import { retryQueuedChatMessage } from "./chat-send-actions.ts";
import * as submit from "./chat-send-submit.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const original = {
  id: "saved-input",
  runId: "original-run",
  state: "interrupted",
  acceptedAt: 100,
  message: { role: "user", content: "preview", __openclaw: { truncated: true } },
} satisfies ChatPendingInputsPage["items"][number];

function full(
  content: unknown = "complete request",
  metadata: Record<string, unknown> = {},
): ChatMessageGetResult {
  return {
    ok: true,
    message: {
      role: "user",
      content,
      __openclaw: {
        id: CHAT_PENDING_INPUT_MESSAGE_PREFIX + original.id,
        senderId: "other-human",
        ...metadata,
      },
    },
  };
}

function localInput(sendState: ChatQueueItem["sendState"]): ChatQueueItem {
  return {
    id: "local-input",
    sendRunId: original.runId,
    text: "Owned request",
    createdAt: 100,
    sendState,
  };
}

function preference() {
  const saved = new Set<string>();
  return {
    has: (key: string) => saved.has(key),
    add: vi.fn((key: string) => {
      saved.add(key);
      return true;
    }),
  } satisfies ChatInputRecoveryDismissals;
}

function fixture(
  response: ChatMessageGetResult | Promise<ChatMessageGetResult> = full(),
  dismissals = preference(),
) {
  const host = Object.assign(
    makeChatHost({
      sessionKey: "agent:main:recovery-actions",
      currentSessionId: "physical-one",
      settings: { gatewayUrl: "ws://gateway.test" },
      selfUser: { id: "current-human", name: "Current human" },
      chatMessage: "unsent draft",
      chatAttachments: [
        { id: "draft-attachment", mimeType: "text/plain", dataUrl: "data:text/plain;base64,ZA==" },
      ],
      chatReplyTarget: { messageId: "draft-reply", text: "draft reply" },
      requestHandlers: { "chat.message.get": response },
    }),
    { chatInputRecoveryDismissals: dismissals },
  );
  const publish = (items: ChatPendingInputsPage["items"] = [original]) =>
    applyChatPendingInputs(host, { items, total: items.length });
  publish();
  return { host, publish, dismissals };
}

beforeEach(() => {
  vi.spyOn(submit, "handleSendChat").mockImplementation(async (_host, _text, options) => {
    options?.onOutboxAdmitted?.();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["user", "gateway", "physical session", "agent", "credential"])(
  "does not share dismissal across a different %s",
  (changed) => {
    const f = fixture();
    discardChatRecoveryInput(f.host, original.id);
    if (changed === "user") {
      f.host.selfUser = { id: "other-viewer", name: "Other viewer" };
    }
    if (changed === "gateway") {
      f.host.settings.gatewayUrl = "ws://other.test";
    }
    if (changed === "physical session") {
      f.host.currentSessionId = "physical-two";
    }
    if (changed === "agent") {
      f.host.sessionKey = "agent:other:recovery-actions";
    }
    if (changed === "credential") {
      Object.defineProperty(f.host.client, "recoveryScope", { get: () => "different-owner" });
    }
    f.publish();
    expect(getChatInputRecovery(f.host).items).toEqual([original]);
  },
);

it("keeps same-client saved rows visible during reconnect but refuses a stale-epoch Send", async () => {
  const f = fixture();
  f.publish([{ ...original, state: "queued" }]);
  discardChatRecoveryInput(f.host, original.id);
  expect(f.dismissals.add).not.toHaveBeenCalled();
  f.publish();
  f.host.connectionEpoch += 1;
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
  await sendChatRecoveryInput(f.host, original.id);
  expect(f.host.request).not.toHaveBeenCalled();
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  f.publish();
  await sendChatRecoveryInput(f.host, original.id);
  expect(submit.handleSendChat).toHaveBeenCalledTimes(1);
});

it("keeps a rejected admission available and reports the normal send owner's error", async () => {
  const f = fixture();
  vi.mocked(submit.handleSendChat).mockImplementationOnce(async (host) => {
    host.chatError = "Session is read-only";
    return false;
  });
  await sendChatRecoveryInput(f.host, original.id);
  expect(getChatInputRecovery(f.host)).toMatchObject({
    items: [original],
    error: "Session is read-only",
  });
  expect(f.dismissals.add).not.toHaveBeenCalled();
});

it("hands uncertain delivery exclusively to the normal outbox, without another fresh send", async () => {
  const f = fixture();
  vi.mocked(submit.handleSendChat).mockImplementationOnce(async (_host, _text, options) => {
    options?.onOutboxAdmitted?.();
    throw new Error("connection lost after submission");
  });
  await sendChatRecoveryInput(f.host, original.id);
  await sendChatRecoveryInput(f.host, original.id);
  f.publish();
  expect(getChatInputRecovery(f.host).items).toEqual([]);
  expect(submit.handleSendChat).toHaveBeenCalledTimes(1);
});

it.each([
  "session",
  "connection",
  "gateway",
  "gateway query",
  "user",
  "credential",
  "incognito",
  "custody",
  "replacement input",
  "source provenance",
])("ignores full-message results after %s changes", async (changed) => {
  const gate = createDeferred<ChatMessageGetResult>();
  const f = fixture(gate.promise);
  const sending = sendChatRecoveryInput(f.host, original.id);
  if (changed === "session") {
    f.host.currentSessionId = "replacement";
  }
  if (changed === "connection") {
    f.host.connectionEpoch += 1;
  }
  if (changed === "gateway") {
    f.host.settings.gatewayUrl = "ws://other.test";
  }
  if (changed === "gateway query") {
    f.host.settings.gatewayUrl = "ws://gateway.test?account=other";
  }
  if (changed === "user") {
    f.host.selfUser = { id: "other-viewer", name: "Other viewer" };
  }
  if (changed === "credential") {
    Object.defineProperty(f.host.client, "recoveryScope", { get: () => "new-owner" });
  }
  if (changed === "incognito") {
    f.host.selectedChatSessionIncognito = true;
  }
  if (changed === "custody") {
    f.publish([{ ...original, state: "queued" }]);
  }
  if (changed === "replacement input") {
    f.publish([{ ...original, runId: "replacement-run" }]);
  }
  if (changed === "source provenance") {
    f.publish([
      {
        ...original,
        message: { ...original.message, provenance: { kind: "inter_session" } },
      },
    ]);
  }
  gate.resolve(full());
  await sending;
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  expect(f.dismissals.add).not.toHaveBeenCalled();
});

it.each([
  { name: "truncated", result: full("partial", { truncated: true }) },
  { name: "display cap without flag", result: full("partial", { reason: "display-cap" }) },
  {
    name: "oversized marker",
    result: full("placeholder", { truncated: false, reason: "oversized" }),
  },
  {
    name: "malformed truncation flag",
    result: full("partial", { truncated: { reason: "display-cap" } }),
  },
  { name: "wrong input", result: full("other request", { id: "other-id" }) },
  { name: "missing", result: { ok: false, unavailableReason: "not_found" } },
  { name: "oversized", result: { ok: false, unavailableReason: "oversized" } },
  {
    name: "omitted media",
    result: full([
      { type: "text", text: "must not send alone" },
      { type: "image", omitted: true },
    ]),
  },
  {
    name: "remote media",
    result: full([
      { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
    ]),
  },
  {
    name: "inline media",
    result: full([
      { type: "text", text: "image request" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aQ==" } },
    ]),
  },
  { name: "media facts", result: full("photo", { media: [{ path: "media://inbound/image" }] }) },
  { name: "unknown block", result: full([{ type: "custom", text: "not ordinary text" }]) },
  { name: "slash command", result: full("/stop") },
  { name: "stop alias", result: full("stop") },
  { name: "shell command", result: full("!rm file") },
] satisfies { name: string; result: ChatMessageGetResult }[])(
  "does not resend $name as an ordinary complete user message",
  async ({ result }) => {
    const f = fixture(result);
    const attachments = f.host.chatAttachments;
    await sendChatRecoveryInput(f.host, original.id);
    expect(submit.handleSendChat).not.toHaveBeenCalled();
    expect(getChatInputRecovery(f.host).items).toEqual([original]);
    expect(getChatInputRecovery(f.host).error).toBeTruthy();
    expect(f.host.chatMessage).toBe("unsent draft");
    expect(f.host.chatAttachments).toBe(attachments);
  },
);

it.each(["held", "failed"] as const)(
  "retires only the duplicate presentation when native %s custody is displayed",
  async (sendState) => {
    const f = fixture();
    const owned: ChatQueueItem = {
      ...localInput(sendState),
      sessionId: f.host.currentSessionId ?? undefined,
    };
    const untouchedQueue = [owned];
    f.host.chatQueue = untouchedQueue;
    expect(getChatInputRecovery(f.host).items).toEqual([]);
    expect(f.dismissals.add).toHaveBeenCalledTimes(1);
    getChatInputRecovery(f.host);
    await sendChatRecoveryInput(f.host, original.id);
    expect(f.dismissals.add).toHaveBeenCalledTimes(1);
    expect(f.host.chatQueue).toBe(untouchedQueue);
    expect(f.host.chatQueue[0]).toBe(owned);
    expect(f.host.request).not.toHaveBeenCalled();
    expect(submit.handleSendChat).not.toHaveBeenCalled();
  },
);

it("does not reinterpret an uncertain outbox row as a fresh Send", async () => {
  const f = fixture();
  f.publish([{ ...original, state: "cancelled" }]);
  f.host.chatQueue = [localInput("unconfirmed")];
  await sendChatRecoveryInput(f.host, original.id);
  expect(f.host.request).not.toHaveBeenCalled();
  expect(submit.handleSendChat).not.toHaveBeenCalled();
});

it("does not create a fresh send if an outbox owner appears during the full read", async () => {
  const gate = createDeferred<ChatMessageGetResult>();
  const f = fixture(gate.promise);
  const sending = sendChatRecoveryInput(f.host, original.id);
  f.host.chatQueue = [localInput("failed")];
  gate.resolve(full());
  await sending;
  expect(submit.handleSendChat).not.toHaveBeenCalled();
});

const deniedMessages = [
  { role: "assistant", content: "Agent-authored result" },
  { role: "user", content: "Internal prompt", provenance: { kind: "internal_system" } },
  { role: "user", content: "Routed data", provenance: { kind: "inter_session" } },
  { role: "user", content: "Unknown source", provenance: { kind: "unrecognized" } },
];

it.each(deniedMessages)(
  "keeps $role/$content inspectable but never reauthors it",
  async (message) => {
    const f = fixture();
    f.publish([{ ...original, message }]);
    await sendChatRecoveryInput(f.host, original.id);
    expect(getChatInputRecovery(f.host)).toMatchObject({
      items: [{ ...original, message }],
      error: expect.any(String),
    });
    expect(submit.handleSendChat).not.toHaveBeenCalled();
    await toggleChatRecoveryInput(f.host, original.id, true);
    expect(getChatInputRecovery(f.host).expandedIds.has(original.id)).toBe(true);
    expect(f.host.request).not.toHaveBeenCalled();
  },
);

it.each(deniedMessages)(
  "rechecks the complete $role/$content source after reading an ordinary preview",
  async (message) => {
    const f = fixture({
      ok: true,
      message: { ...message, __openclaw: { id: CHAT_PENDING_INPUT_MESSAGE_PREFIX + original.id } },
    });
    await sendChatRecoveryInput(f.host, original.id);
    expect(f.host.request).toHaveBeenCalledTimes(1);
    expect(submit.handleSendChat).not.toHaveBeenCalled();
    expect(f.dismissals.add).not.toHaveBeenCalled();
  },
);

it("accepts explicit external-user provenance without interpreting literal cap text", async () => {
  const message = {
    role: "user",
    content: "Please include ...(truncated)... literally.",
    provenance: { kind: "external_user" },
    __openclaw: { id: CHAT_PENDING_INPUT_MESSAGE_PREFIX + original.id, truncated: false },
  };
  const f = fixture({ ok: true, message });
  f.publish([{ ...original, message }]);
  f.host.chatFollowUpMode = "steer";
  await sendChatRecoveryInput(f.host, original.id);
  expect(submit.handleSendChat).toHaveBeenCalledWith(f.host, message.content, {
    attachmentsOverride: [],
    replyTargetOverride: null,
    onOutboxAdmitted: expect.any(Function),
  });
  expect(f.host.chatFollowUpMode).toBe("steer");
});

it("captures the dismissal adapter before the full-message read", async () => {
  const gate = createDeferred<ChatMessageGetResult>();
  const f = fixture(gate.promise);
  const replacement = preference();
  const sending = sendChatRecoveryInput(f.host, original.id);
  // A rerender can replace the adapter even without changing connection scope.
  f.host.chatInputRecoveryDismissals = replacement;
  gate.resolve(full());
  await sending;
  expect(f.dismissals.add).toHaveBeenCalledTimes(1);
  expect(replacement.add).not.toHaveBeenCalled();
});

it.each(["gateway", "incognito", "user", "client"])(
  "keeps a late admission's dismissal with its original adapter and view after a %s switch",
  async (changed) => {
    const f = fixture();
    const replacement = preference();
    const admission = createDeferred<() => void>();
    const settlement = createDeferred<Awaited<ReturnType<typeof submit.handleSendChat>>>();
    vi.mocked(submit.handleSendChat).mockImplementationOnce(async (_host, _text, options) => {
      admission.resolve(() => options?.onOutboxAdmitted?.());
      return settlement.promise;
    });
    const sending = sendChatRecoveryInput(f.host, original.id);
    const admit = await admission.promise;
    if (changed === "gateway") {
      f.host.settings.gatewayUrl = "ws://other.test";
    }
    if (changed === "incognito") {
      f.host.selectedChatSessionIncognito = true;
    }
    if (changed === "user") {
      f.host.selfUser = { id: "other-viewer", name: "Other viewer" };
    }
    if (changed === "client") {
      f.host.client = fixture().host.client;
    }
    f.host.chatInputRecoveryDismissals = replacement;
    f.publish();
    admit();
    settlement.resolve(false);
    await sending;
    expect(f.dismissals.add).toHaveBeenCalledTimes(1);
    expect(replacement.add).not.toHaveBeenCalled();
    expect(getChatInputRecovery(f.host).items).toEqual([original]);
    expect(getChatInputRecovery(f.host).busyIds.size).toBe(0);
  },
);

it("shares busy and dismissed decisions between two panes on the same client and scope", async () => {
  const gate = createDeferred<ChatMessageGetResult>();
  const first = fixture(gate.promise);
  const second = fixture(full(), first.dismissals);
  second.host.client = first.host.client;
  second.publish();
  const sending = sendChatRecoveryInput(first.host, original.id);
  await sendChatRecoveryInput(first.host, original.id);
  discardChatRecoveryInput(first.host, original.id);
  expect(getChatInputRecovery(second.host).busyIds.has(original.id)).toBe(true);
  await sendChatRecoveryInput(second.host, original.id);
  discardChatRecoveryInput(second.host, original.id);
  expect(first.dismissals.add).not.toHaveBeenCalled();
  gate.resolve(full());
  await sending;
  expect(submit.handleSendChat).toHaveBeenCalledTimes(1);
  expect(first.host.request).toHaveBeenCalledTimes(1);
  expect(getChatInputRecovery(second.host).items).toEqual([]);
  expect(getChatInputRecovery(first.host).busyIds.size).toBe(0);
});

it.each(["gateway", "user", "credential", "client"])(
  "does not rebind an already displayed pending page to a new %s without fresh custody",
  (changed) => {
    const f = fixture();
    expect(getChatInputRecovery(f.host).items).toEqual([original]);
    if (changed === "gateway") {
      f.host.settings.gatewayUrl = "ws://other.test";
    }
    if (changed === "user") {
      f.host.selfUser = { id: "other-viewer", name: "Other viewer" };
    }
    if (changed === "credential") {
      Object.defineProperty(f.host.client, "recoveryScope", { get: () => "new-owner" });
    }
    if (changed === "client") {
      f.host.client = fixture().host.client;
    }
    expect(getChatInputRecovery(f.host).items).toEqual([]);
    f.publish();
    expect(getChatInputRecovery(f.host).items).toEqual([original]);
  },
);

it("retains same-client presentation, but not Send authority, while recovery admission is pending", async () => {
  const f = fixture();
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
  Object.defineProperty(f.host.client, "recoveryScopeReady", { get: () => false });
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
  await sendChatRecoveryInput(f.host, original.id);
  expect(f.host.request).not.toHaveBeenCalled();
  expect(submit.handleSendChat).not.toHaveBeenCalled();
});

it("does not persist userinfo, query credentials or fragments in dismissal keys", () => {
  const f = fixture();
  f.host.settings.gatewayUrl =
    "wss://viewer:password@gateway.test/rpc?token=query-secret#fragment-secret";
  discardChatRecoveryInput(f.host, original.id);
  const key = f.dismissals.add.mock.calls[0]?.[0];
  expect(key).toContain("wss://gateway.test/rpc");
  expect(key).not.toMatch(/password|query-secret|fragment-secret/);
});

it("retains the bound viewer when real disconnect clears hello/selfUser, without Send authority", async () => {
  const f = fixture();
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
  f.host.connected = false;
  f.host.connectionEpoch += 1;
  f.host.hello = null;
  f.host.selfUser = null;
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
  await sendChatRecoveryInput(f.host, original.id);
  expect(f.host.request).not.toHaveBeenCalled();
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  discardChatRecoveryInput(f.host, original.id);
  f.host.connected = true;
  f.host.selfUser = { id: "current-human", name: "Current human" };
  f.publish();
  expect(getChatInputRecovery(f.host).items).toEqual([]);
});

it("does not bind an unseen or replacement client's viewer while disconnected", () => {
  const f = fixture();
  f.host.connected = false;
  f.host.hello = null;
  f.host.selfUser = null;
  expect(getChatInputRecovery(f.host).items).toEqual([]);
  f.host.connected = true;
  f.host.selfUser = { id: "current-human", name: "Current human" };
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
  f.host.client = fixture().host.client;
  f.host.connected = false;
  f.host.selfUser = null;
  expect(getChatInputRecovery(f.host).items).toEqual([]);
});

it.each(["before action", "during read"])("rejects an actual disposed host %s", async (when) => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
  const gate = createDeferred<ChatMessageGetResult>();
  const controller = new ChatStateController<ChatPageHost>({
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: () => undefined,
    updateComplete: Promise.resolve(true),
  });
  const host = makeChatPageHost({
    sessionKey: "agent:main:disposed-recovery",
    currentSessionId: "disposed-physical",
    selfUser: { id: "current-human", name: "Current human" },
    requestHandlers: { "chat.message.get": gate.promise },
  });
  controller.hostConnected();
  host.renderLifecycle = controller.createRenderLifecycle();
  controller.attach(host);
  controller.composerPersistence.start();
  try {
    expect(host.canRestoreComposer?.()).toBe(true);
    applyChatPendingInputs(host, { items: [original], total: 1 });
    expect(getChatInputRecovery(host).items).toEqual([original]);
    if (when === "before action") {
      controller.hostDisconnected();
    }
    const sending = sendChatRecoveryInput(host, original.id);
    controller.hostDisconnected();
    // Connection fields intentionally remain current on the captured old host.
    expect(host.connected).toBe(true);
    expect(host.canRestoreComposer?.()).toBe(false);
    gate.resolve(full());
    await sending;
    expect(submit.handleSendChat).not.toHaveBeenCalled();
    if (when === "before action") {
      expect(host.request).not.toHaveBeenCalled();
    }
  } finally {
    gate.resolve(full());
    controller.hostDisconnected();
  }
});

it("native Retry cannot reoffer its retired saved source during deferred drain or reconnect", async () => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
  const gate = createDeferred<Awaited<ReturnType<typeof drain.scheduleStoredChatOutboxDrain>>>();
  vi.spyOn(drain, "scheduleStoredChatOutboxDrain").mockReturnValue(gate.promise);
  const f = fixture();
  f.host.chatRunId = "active-run";
  const owned: ChatQueueItem = {
    ...localInput("failed"),
    id: "admitted-local-input",
    sessionId: f.host.currentSessionId ?? undefined,
    sessionKey: f.host.sessionKey,
  };
  const unsubscribe = chatOutboxOwner(f.host).subscribe(f.host);
  try {
    expect(
      queue.admitQueuedMessageForSession(
        f.host,
        captureChatOutboxAdmission(f.host, f.host.sessionKey),
        owned,
      ),
    ).toBe(true);
    expect(getChatInputRecovery(f.host).items).toEqual([]);
    expect(f.dismissals.add).toHaveBeenCalledTimes(1);
    const sending = retryQueuedChatMessage(f.host, owned.id);
    expect(drain.scheduleStoredChatOutboxDrain).toHaveBeenCalledTimes(1);
    expect(queue.readQueuedMessageById(f.host, owned.id)?.sendRunId).not.toBe(original.runId);
    f.host.connected = false;
    f.host.connectionEpoch += 1;
    f.host.hello = null;
    f.host.selfUser = null;
    expect(getChatInputRecovery(f.host).items).toEqual([]);
    gate.resolve(undefined);
    await sending;
    f.host.connected = true;
    f.host.selfUser = { id: "current-human", name: "Current human" };
    f.publish();
    expect(getChatInputRecovery(f.host).items).toEqual([]);
    expect(f.host.request).not.toHaveBeenCalled();
    expect(submit.handleSendChat).not.toHaveBeenCalled();
  } finally {
    gate.resolve(undefined);
    unsubscribe();
  }
});

it("reads capped input only on explicit disclosure and retains the raw full message for shared rendering", async () => {
  const result = full([
    { type: "text", text: "Complete text" },
    { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
  ]);
  const f = fixture(result);
  getChatInputRecovery(f.host);
  expect(f.host.request).not.toHaveBeenCalled();
  await toggleChatRecoveryInput(f.host, original.id, true);
  expect(f.host.request).toHaveBeenCalledWith("chat.message.get", {
    sessionKey: f.host.sessionKey,
    agentId: "main",
    messageId: CHAT_PENDING_INPUT_MESSAGE_PREFIX + original.id,
    maxChars: 2_000_000,
  });
  expect(getChatInputRecovery(f.host).inspections.get(original.id)).toMatchObject({
    status: "loaded",
    message: result.message,
    markdown: "Complete text",
  });
  await toggleChatRecoveryInput(f.host, original.id, true);
  expect(f.host.request).toHaveBeenCalledTimes(1);
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  expect(f.dismissals.add).not.toHaveBeenCalled();
});

it("opens uncapped raw input without any read or copied payload cache", async () => {
  const f = fixture();
  f.publish([{ ...original, message: { role: "user", content: "Complete source" } }]);
  await toggleChatRecoveryInput(f.host, original.id, true);
  const recovery = getChatInputRecovery(f.host);
  expect(recovery.expandedIds.has(original.id)).toBe(true);
  expect(recovery.inspections.size).toBe(0);
  expect(f.host.request).not.toHaveBeenCalled();
});

it.each(["close", "dismiss", "replacement", "removal", "epoch", "disconnect", "dispose"])(
  "invalidates late full-input inspection after %s",
  async (changed) => {
    const gate = createDeferred<ChatMessageGetResult>();
    const f = fixture(gate.promise);
    const opening = toggleChatRecoveryInput(f.host, original.id, true);
    const inspections = getChatInputRecovery(f.host).inspections;
    expect(inspections.get(original.id)?.status).toBe("loading");
    if (changed === "close") {
      await toggleChatRecoveryInput(f.host, original.id, false);
    }
    if (changed === "dismiss") {
      discardChatRecoveryInput(f.host, original.id);
    }
    if (changed === "replacement") {
      f.publish([{ ...original, runId: "new-attempt" }]);
    }
    if (changed === "removal") {
      f.publish([]);
    }
    if (changed === "epoch") {
      f.host.connectionEpoch += 1;
    }
    if (changed === "disconnect") {
      f.host.connected = false;
      f.host.hello = null;
      f.host.selfUser = null;
    }
    if (changed === "dispose") {
      f.host.canRestoreComposer = () => false;
    }
    gate.resolve(full());
    await opening;
    expect(inspections.has(original.id)).toBe(false);
    expect(getChatInputRecovery(f.host).expandedIds.has(original.id)).toBe(false);
    expect(submit.handleSendChat).not.toHaveBeenCalled();
  },
);

it("an old closed inspection cannot overwrite a newer explicit open", async () => {
  const firstRead = createDeferred<ChatMessageGetResult>();
  const secondRead = createDeferred<ChatMessageGetResult>();
  const f = fixture(firstRead.promise);
  const first = toggleChatRecoveryInput(f.host, original.id, true);
  await toggleChatRecoveryInput(f.host, original.id, false);
  f.host.request.mockImplementationOnce(() => secondRead.promise);
  const second = toggleChatRecoveryInput(f.host, original.id, true);
  firstRead.resolve(full("Old result"));
  await first;
  expect(getChatInputRecovery(f.host).inspections.get(original.id)?.status).toBe("loading");
  secondRead.resolve(full("New result"));
  await second;
  expect(getChatInputRecovery(f.host).inspections.get(original.id)).toMatchObject({
    status: "loaded",
    markdown: "New result",
  });
});

it("keeps inspection local to its pane while shared send guards stay separate", async () => {
  const gate = createDeferred<ChatMessageGetResult>();
  const first = fixture(gate.promise);
  const second = fixture();
  second.host.client = first.host.client;
  second.publish([{ ...original, message: { ...original.message } }]);
  const opening = toggleChatRecoveryInput(first.host, original.id, true);
  expect(getChatInputRecovery(second.host).expandedIds.size).toBe(0);
  expect(getChatInputRecovery(second.host).inspections.size).toBe(0);
  gate.resolve(full());
  await opening;
  expect(getChatInputRecovery(first.host).inspections.get(original.id)?.status).toBe("loaded");
  expect(getChatInputRecovery(second.host).inspections.size).toBe(0);
  await toggleChatRecoveryInput(second.host, original.id, true);
  expect(first.host.request).toHaveBeenCalledTimes(2);
  await toggleChatRecoveryInput(first.host, original.id, false);
  expect(getChatInputRecovery(second.host).expandedIds.has(original.id)).toBe(true);
  second.publish([]);
  expect(getChatInputRecovery(second.host).inspections.size).toBe(0);
  expect(getChatInputRecovery(second.host).expandedIds.size).toBe(0);
});

it("retries an expanded inspection only on an explicit Retry action, never render or refresh", async () => {
  const f = fixture({ ok: false, unavailableReason: "not_found" });
  await toggleChatRecoveryInput(f.host, original.id, true);
  expect(getChatInputRecovery(f.host).inspections.get(original.id)?.status).toBe("error");
  f.publish();
  getChatInputRecovery(f.host);
  expect(f.host.request).toHaveBeenCalledTimes(1);
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  await toggleChatRecoveryInput(f.host, original.id, true);
  expect(f.host.request).toHaveBeenCalledTimes(2);
});

it("keeps native projection suppression side-effect free until the dismissal adapter is installed", () => {
  const f = fixture();
  const host: ChatInputRecoveryHost = f.host;
  delete host.chatInputRecoveryDismissals;
  host.chatQueue = [localInput("held")];
  expect(getChatInputRecovery(host).items).toEqual([]);
  expect(f.dismissals.add).not.toHaveBeenCalled();
  host.chatQueue = [];
  expect(getChatInputRecovery(host).items).toEqual([original]);
  host.chatQueue = [localInput("held")];
  host.chatInputRecoveryDismissals = f.dismissals;
  expect(getChatInputRecovery(host).items).toEqual([]);
  expect(f.dismissals.add).toHaveBeenCalledTimes(1);
  expect(f.host.request).not.toHaveBeenCalled();
});

it.each(["discard", "native handoff"])(
  "retains a failed %s dismissal locally without retrying preference writes on render",
  (action) => {
    const f = fixture();
    f.dismissals.add.mockReturnValue(false);
    if (action === "discard") {
      discardChatRecoveryInput(f.host, original.id);
    } else {
      f.host.chatQueue = [localInput("failed")];
    }
    expect(getChatInputRecovery(f.host)).toMatchObject({ items: [], error: expect.any(String) });
    f.host.chatQueue = [];
    expect(getChatInputRecovery(f.host).items).toEqual([]);
    expect(f.dismissals.add).toHaveBeenCalledTimes(1);
    expect(f.host.request).not.toHaveBeenCalled();
  },
);

it.each(["epoch", "client", "gateway", "viewer", "admission", "offline", "disposed"])(
  "does not infer duplicate presentation handoff from a stale %s scope",
  (changed) => {
    const f = fixture();
    expect(getChatInputRecovery(f.host).items).toEqual([original]);
    f.host.chatQueue = [localInput("held")];
    if (changed === "epoch") {
      f.host.connectionEpoch += 1;
    }
    if (changed === "client") {
      f.host.client = fixture().host.client;
    }
    if (changed === "gateway") {
      f.host.settings.gatewayUrl = "ws://different.test";
    }
    if (changed === "viewer") {
      f.host.selfUser = { id: "different-viewer", name: "Different viewer" };
    }
    if (changed === "admission") {
      Object.defineProperty(f.host.client, "recoveryScopeReady", { get: () => false });
    }
    if (changed === "offline") {
      f.host.connected = false;
    }
    if (changed === "disposed") {
      f.host.canRestoreComposer = () => false;
    }
    const queueBefore = f.host.chatQueue;
    getChatInputRecovery(f.host);
    expect(f.dismissals.add).not.toHaveBeenCalled();
    expect(f.host.chatQueue).toBe(queueBefore);
    expect(f.host.request).not.toHaveBeenCalled();
  },
);

it.each([
  { ...original, queued: true as const },
  { ...original, state: "cancelled" as const },
])("does not retire $state/$queued custody merely because a local row matches", (input) => {
  const f = fixture();
  f.publish([input]);
  f.host.chatQueue = [localInput("held")];
  getChatInputRecovery(f.host);
  expect(f.dismissals.add).not.toHaveBeenCalled();
  expect(f.host.request).not.toHaveBeenCalled();
});

it("does not rebind an old displayed page to a new viewer when only latest custody refreshes", async () => {
  const f = fixture();
  const refresh = createDeferred<unknown>();
  let reads = 0;
  f.host.request.mockImplementation(async (method: string) => {
    if (method !== "chat.history") {
      throw new Error("Unexpected write or read");
    }
    if (++reads > 1) {
      return refresh.promise;
    }
    return { sessionId: "physical-one", pendingInputs: { items: [original], total: 2 } };
  });
  await loadChatPendingInputs(f.host, 80);
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
  f.host.selfUser = { id: "new-viewer", name: "New viewer" };
  f.publish([{ ...original, id: "latest", acceptedAt: 200 }]);
  expect(getChatInputRecovery(f.host).items).toEqual([]);
  expect(f.dismissals.add).not.toHaveBeenCalled();
  const oldPage = getChatPendingInputs(f.host)?.page;
  const published = createDeferred();
  f.host.requestUpdate = () => {
    if (getChatPendingInputs(f.host)?.page !== oldPage) {
      published.resolve();
    }
  };
  refresh.resolve({ sessionId: "physical-one", pendingInputs: { items: [original], total: 2 } });
  await published.promise;
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
});

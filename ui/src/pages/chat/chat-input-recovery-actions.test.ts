/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type {
  ChatMessageGetResult,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  discardChatRecoveryInput,
  getChatInputRecovery,
  sendChatRecoveryInput,
  type ChatInputRecoveryDismissals,
} from "./chat-input-recovery-actions.ts";
import { applyChatPendingInputs, getChatRecoveryInputs } from "./chat-pending-inputs.ts";
import * as queue from "./chat-queue.ts";
import * as retry from "./chat-send-actions.ts";
import * as submit from "./chat-send-submit.ts";

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
  role: "user" | "assistant" = "user",
): ChatMessageGetResult {
  return {
    ok: true,
    message: {
      role,
      content,
      __openclaw: {
        id: CHAT_PENDING_INPUT_MESSAGE_PREFIX + original.id,
        senderId: "other-human",
        ...metadata,
      },
    },
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
    return true;
  });
  vi.spyOn(retry, "retryQueuedChatMessage").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it("is inert on display and dismisses only the viewer's inactive record", () => {
  const f = fixture();
  const untouchedQueue = f.host.chatQueue;
  expect(getChatInputRecovery(f.host).items).toEqual([original]);
  expect(f.host.request).not.toHaveBeenCalled();
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  discardChatRecoveryInput(f.host, original.id);
  expect(getChatInputRecovery(f.host).items).toEqual([]);
  expect(getChatRecoveryInputs(f.host)).toEqual([original]);
  expect(f.host.chatQueue).toBe(untouchedQueue);
  expect(f.host.request).not.toHaveBeenCalled();
  const reopened = fixture(full(), f.dismissals);
  expect(getChatInputRecovery(reopened.host).items).toEqual([]);
  expect(f.dismissals.add).toHaveBeenCalledTimes(1);
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

it("fetches the full saved input and delegates ordinary Send without touching the draft or original author", async () => {
  const f = fixture();
  const attachments = f.host.chatAttachments;
  const replyTarget = f.host.chatReplyTarget;
  const untouchedQueue = f.host.chatQueue;
  await sendChatRecoveryInput(f.host, original.id);
  expect(f.host.request).toHaveBeenCalledWith("chat.message.get", {
    sessionKey: f.host.sessionKey,
    agentId: "main",
    messageId: CHAT_PENDING_INPUT_MESSAGE_PREFIX + original.id,
    maxChars: 2_000_000,
  });
  expect(submit.handleSendChat).toHaveBeenCalledWith(f.host, "complete request", {
    attachmentsOverride: [],
    replyTargetOverride: null,
    onOutboxAdmitted: expect.any(Function),
  });
  expect(f.host.chatMessage).toBe("unsent draft");
  expect(f.host.chatAttachments).toBe(attachments);
  expect(f.host.chatReplyTarget).toBe(replyTarget);
  expect(f.host.chatQueue).toBe(untouchedQueue);
  expect(getChatInputRecovery(f.host).items).toEqual([]);
  expect(getChatRecoveryInputs(f.host)).toEqual([original]);
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

it("coalesces repeated clicks and does not discard during a read", async () => {
  const gate = createDeferred<ChatMessageGetResult>();
  const f = fixture(gate.promise);
  const sending = sendChatRecoveryInput(f.host, original.id);
  await sendChatRecoveryInput(f.host, original.id);
  discardChatRecoveryInput(f.host, original.id);
  expect(getChatInputRecovery(f.host).busyIds.has(original.id)).toBe(true);
  expect(f.dismissals.add).not.toHaveBeenCalled();
  gate.resolve(full());
  await sending;
  expect(f.host.request).toHaveBeenCalledTimes(1);
  expect(submit.handleSendChat).toHaveBeenCalledTimes(1);
  expect(getChatInputRecovery(f.host).busyIds.size).toBe(0);
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
  gate.resolve(full());
  await sending;
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  expect(f.dismissals.add).not.toHaveBeenCalled();
});

it.each([
  { name: "truncated", result: full("partial", { truncated: true }) },
  { name: "display cap", result: full("partial", { truncated: true, reason: "display-cap" }) },
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
  { name: "media facts", result: full("photo", { media: [{ path: "media://inbound/image" }] }) },
  { name: "unknown block", result: full([{ type: "custom", text: "not ordinary text" }]) },
  { name: "slash command", result: full("/stop") },
  { name: "stop alias", result: full("stop") },
  { name: "shell command", result: full("!rm file") },
] satisfies { name: string; result: ChatMessageGetResult }[])(
  "never replays $name as a partial or privileged request",
  async ({ result }) => {
    const f = fixture(result);
    await sendChatRecoveryInput(f.host, original.id);
    expect(submit.handleSendChat).not.toHaveBeenCalled();
    expect(getChatInputRecovery(f.host).items).toEqual([original]);
    expect(getChatInputRecovery(f.host).error).toBeTruthy();
    expect(f.host.chatMessage).toBe("unsent draft");
  },
);

it("rejects unsupported media instead of borrowing unrelated composer attachments", async () => {
  const f = fixture(
    full([
      { type: "text", text: "image request" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aQ==" } },
    ]),
  );
  const attachments = f.host.chatAttachments;
  await sendChatRecoveryInput(f.host, original.id);
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  expect(f.host.chatAttachments).toBe(attachments);
  expect(getChatInputRecovery(f.host).error).toBeTruthy();
});

it("uses an existing inactive outbox retry instead of minting a new payload", async () => {
  const f = fixture();
  const owned: ChatQueueItem = {
    id: "local-input",
    sendRunId: original.runId,
    text: "owned complete request",
    createdAt: 100,
    sendState: "failed",
    sessionId: f.host.currentSessionId ?? undefined,
    attachments: [{ id: "outbox-image", mimeType: "image/png" }],
    attachmentPayload: {
      key: "owned-blob",
      tabId: "owned-tab",
      recoveryScope: "test-recovery-scope",
    },
  };
  f.host.chatQueue = [owned];
  vi.spyOn(queue, "readQueuedMessageById").mockReturnValue({
    ...owned,
    sendState: "sending",
    sendRunId: "retry-owned-run",
  });
  await sendChatRecoveryInput(f.host, original.id);
  expect(retry.retryQueuedChatMessage).toHaveBeenCalledWith(f.host, owned.id, expect.any(Function));
  expect(f.host.request).not.toHaveBeenCalled();
  expect(submit.handleSendChat).not.toHaveBeenCalled();
  expect(f.host.chatQueue).toEqual([owned]);
});

it("does not reinterpret an uncertain outbox row as a fresh Send", async () => {
  const f = fixture();
  f.publish([{ ...original, state: "cancelled" }]);
  f.host.chatQueue = [
    {
      id: "local-input",
      sendRunId: original.runId,
      text: "original",
      createdAt: 100,
      sendState: "unconfirmed",
    },
  ];
  await sendChatRecoveryInput(f.host, original.id);
  expect(f.host.request).not.toHaveBeenCalled();
  expect(retry.retryQueuedChatMessage).not.toHaveBeenCalled();
  expect(submit.handleSendChat).not.toHaveBeenCalled();
});

it("does not create a fresh send if an outbox owner appears during the full read", async () => {
  const gate = createDeferred<ChatMessageGetResult>();
  const f = fixture(gate.promise);
  const sending = sendChatRecoveryInput(f.host, original.id);
  f.host.chatQueue = [
    {
      id: "local-input",
      sendRunId: original.runId,
      text: "original",
      createdAt: 100,
      sendState: "failed",
    },
  ];
  gate.resolve(full());
  await sending;
  expect(submit.handleSendChat).not.toHaveBeenCalled();
});

it("reports preference failure while retaining the document-local dismissal", () => {
  const dismissals = preference();
  dismissals.add.mockReturnValue(false);
  const f = fixture(full(), dismissals);
  discardChatRecoveryInput(f.host, original.id);
  expect(getChatInputRecovery(f.host).items).toEqual([]);
  expect(getChatInputRecovery(f.host).error).toBeTruthy();
  expect(f.host.request).not.toHaveBeenCalled();
});

it("forwards complete assistant text through normal current-user Send without changing the selected mode", async () => {
  const text = "Forwarded result: ...(truncated)... is literal source text.";
  const f = fixture(full(text, { senderId: "original-agent", truncated: false }, "assistant"));
  f.host.chatFollowUpMode = "steer";
  f.publish([{ ...original, message: { role: "assistant", content: "forwarded preview" } }]);
  await sendChatRecoveryInput(f.host, original.id);
  expect(submit.handleSendChat).toHaveBeenCalledWith(f.host, text, {
    attachmentsOverride: [],
    replyTargetOverride: null,
    onOutboxAdmitted: expect.any(Function),
  });
  expect(f.host.selfUser?.id).toBe("current-human");
  expect(f.host.chatFollowUpMode).toBe("steer");
  expect(f.host.chatMessage).toBe("unsent draft");
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
    const settlement = createDeferred<boolean>();
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
  expect(getChatInputRecovery(second.host).busyIds.has(original.id)).toBe(true);
  await sendChatRecoveryInput(second.host, original.id);
  discardChatRecoveryInput(second.host, original.id);
  expect(first.dismissals.add).not.toHaveBeenCalled();
  gate.resolve(full());
  await sending;
  expect(submit.handleSendChat).toHaveBeenCalledTimes(1);
  expect(first.host.request).toHaveBeenCalledTimes(1);
  expect(getChatInputRecovery(second.host).items).toEqual([]);
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

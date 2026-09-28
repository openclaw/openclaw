/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessageGetResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatInputRecovery, sendChatRecoveryInput } from "./chat-input-recovery-actions.ts";
import { createChatInputRecoveryQueueProps } from "./chat-input-recovery-view.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { makeChatPageHost } from "./chat-pending-inputs.test-support.ts";
import {
  applyChatPendingInputs,
  getChatRecoveryInputs,
  loadChatPendingInputs,
} from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fullInput = {
  ok: true,
  message: {
    role: "user",
    content: "Recovered full prompt",
    __openclaw: { id: "pending:saved", senderId: "original-author" },
  },
} satisfies ChatMessageGetResult;

function fixture() {
  const host = makeChatPageHost({
    sessionKey: "agent:main:queue-recovery",
    currentSessionId: "queue-recovery-physical",
    selfUser: { id: "viewer", name: "Viewer" },
    chatMessage: "Keep this draft",
    chatAttachments: [
      { id: "draft-attachment", mimeType: "text/plain", dataUrl: "data:text/plain;base64,ZA==" },
    ],
    chatReplyTarget: { messageId: "draft-reply", text: "draft reply" },
    requestHandlers: { "chat.message.get": fullInput },
  });
  applyChatPendingInputs(host, {
    items: [
      {
        id: "saved",
        runId: "original-input",
        acceptedAt: 100,
        state: "interrupted",
        message: { role: "user", content: "Preview" },
      },
    ],
    total: 1,
  });
  return host;
}

it("display/discard leave the real outbox unchanged and discard survives a new pane", () => {
  const host = fixture();
  const before = structuredClone(listStoredChatOutboxes(host));
  const source = getChatRecoveryInputs(host);
  const props = createChatInputRecoveryQueueProps(host, true);
  expect(props?.items).toHaveLength(1);
  props?.onDiscard("saved");
  expect(getChatRecoveryInputs(host)).toEqual(source);
  expect(listStoredChatOutboxes(host)).toEqual(before);
  expect(host.chatQueue).toEqual([]);
  expect(host.request).not.toHaveBeenCalled();
  expect(createChatInputRecoveryQueueProps(fixture(), true)).toBeUndefined();
});

it.each(["discarded", "active"])("keeps earlier-page navigation with only %s rows", (state) => {
  const host = fixture();
  const saved = getChatInputRecovery(host).items[0]!;
  applyChatPendingInputs(host, {
    items: [state === "active" ? { ...saved, state: "queued" } : saved],
    total: 21,
    nextBefore: 100,
  });
  if (state === "discarded") {
    createChatInputRecoveryQueueProps(host, true)?.onDiscard("saved");
  }
  const props = createChatInputRecoveryQueueProps(host, true);
  expect(props?.items).toEqual([]);
  expect(props?.paging?.onEarlier).toBeTypeOf("function");
  expect(host.request).not.toHaveBeenCalled();
  expect(host.chatQueue).toEqual([]);
});

it("cannot act on a replacement session through a retained row callback", () => {
  const host = fixture();
  const props = createChatInputRecoveryQueueProps(host, true);
  host.currentSessionId = "replacement";
  props?.onSend?.("saved");
  props?.onDiscard("saved");
  expect(host.request).not.toHaveBeenCalled();
  expect(host.chatQueue).toEqual([]);
});

it("an explicit Send uses real normal admission and does not jump ahead of queued messages", async () => {
  const host = fixture();
  host.chatRunId = "active-run";
  host.chatStream = "Current work";
  host.chatFollowUpMode = "queue";
  const unsubscribe = chatOutboxOwner(host).subscribe(host);
  try {
    for (const [id, createdAt] of [
      ["first", 1],
      ["second", 2],
    ] as const) {
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, host.sessionKey), {
          id,
          text: id,
          createdAt,
          sessionKey: host.sessionKey,
          sendState: "waiting-idle",
        }),
      ).toBe(true);
    }
    const before = host.chatQueue.slice();
    const source = getChatRecoveryInputs(host);
    const { chatAttachments, chatReplyTarget } = host;
    createChatInputRecoveryQueueProps(host, true);
    await sendChatRecoveryInput(host, "saved");
    expect(host.chatQueue.slice(0, 2)).toEqual(before);
    expect(host.chatQueue).toHaveLength(3);
    expect(host.chatQueue[2]).toMatchObject({
      text: "Recovered full prompt",
      sender: { id: "viewer" },
    });
    expect(host.chatQueue[2]?.attachments?.length ?? 0).toBe(0);
    expect(host.chatQueue[2]?.replyToId).toBeUndefined();
    expect(host.chatAttachments).toBe(chatAttachments);
    expect(host.chatReplyTarget).toBe(chatReplyTarget);
    expect(getChatRecoveryInputs(host)).toEqual(source);
    expect(host.chatMessage).toBe("Keep this draft");
    expect(getChatInputRecovery(host).items).toEqual([]);
    expect(
      host.request.mock.calls.filter(
        ([method]) => method === "chat.send" || method === "chat.abort",
      ),
    ).toEqual([]);
  } finally {
    unsubscribe();
  }
});

it.each([
  {
    role: "user",
    provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
  },
  { role: "user", provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
  {
    role: "assistant",
    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    senderSession: { sessionKey: "agent:main:worker", agentId: "main", label: "Worker" },
  },
])("does not promote $role/$provenance.kind into a current-user submission", async (source) => {
  const host = fixture();
  const saved = getChatInputRecovery(host).items[0]!;
  applyChatPendingInputs(host, {
    items: [
      {
        ...saved,
        message: {
          ...source,
          content: "Internal continuation instructions",
          __openclaw: { id: "pending:saved" },
        },
      },
    ],
    total: 1,
  });
  expect(getChatInputRecovery(host).items).toHaveLength(1);
  const before = structuredClone(listStoredChatOutboxes(host));
  await sendChatRecoveryInput(host, "saved");
  expect(host.request).not.toHaveBeenCalled();
  expect(listStoredChatOutboxes(host)).toEqual(before);
  expect(host.chatQueue).toEqual([]);
  expect(host.chatMessage).toBe("Keep this draft");
  expect(getChatInputRecovery(host).items).toHaveLength(1);
});

it.each(
  [
    { phase: "before", identity: "id" },
    { phase: "before", identity: "run" },
    { phase: "during", identity: "id" },
    { phase: "during", identity: "run" },
  ].flatMap(({ phase, identity }) =>
    [false, true].map((waiting) => ({ phase, identity, waiting })),
  ),
)(
  "live custody blocks real duplicate admission $phase the read by $identity (waiting=$waiting)",
  async ({ phase, identity, waiting }) => {
    const host = fixture();
    host.chatRunId = "active-run";
    host.chatStream = "Current work";
    host.chatFollowUpMode = "queue";
    const unsubscribe = chatOutboxOwner(host).subscribe(host);
    try {
      const original = getChatInputRecovery(host).items[0]!;
      const fullRead = createDeferred<ChatMessageGetResult>();
      const historicalRefresh = createDeferred<unknown>();
      let historyReads = 0;
      host.request.mockImplementation(async (method: string) => {
        if (method === "chat.message.get") {
          return fullRead.promise;
        }
        if (method === "chat.history") {
          if (++historyReads === 1) {
            return {
              sessionId: host.currentSessionId,
              pendingInputs: { items: [original], total: 2 },
            };
          }
          return historicalRefresh.promise;
        }
        throw new Error("Unexpected RPC");
      });
      await loadChatPendingInputs(host, 80);
      expect(getChatInputRecovery(host).items).toEqual([original]);
      const before = structuredClone(listStoredChatOutboxes(host));
      const queued = {
        ...original,
        id: identity === "run" ? "rotated-display-id" : original.id,
        state: "queued" as const,
        ...(waiting ? { queued: true as const } : {}),
      };
      let sending: Promise<void> | undefined;
      if (phase === "during") {
        sending = sendChatRecoveryInput(host, original.id);
      }
      applyChatPendingInputs(host, { items: [queued], total: 1, queuedCount: Number(waiting) });
      expect(getChatInputRecovery(host).items).toEqual([]);
      if (phase === "before") {
        sending = sendChatRecoveryInput(host, original.id);
      }
      fullRead.resolve(fullInput);
      await sending;
      expect(listStoredChatOutboxes(host)).toEqual(before);
      expect(host.chatQueue).toEqual([]);
      expect(
        host.request.mock.calls.filter(
          ([method]) => method === "chat.send" || method === "chat.abort",
        ),
      ).toEqual([]);
      historicalRefresh.resolve({
        sessionId: host.currentSessionId,
        pendingInputs: { items: [queued], total: 1, queuedCount: Number(waiting) },
      });
      await host.request.mock.results.at(-1)?.value;
    } finally {
      unsubscribe();
    }
  },
);

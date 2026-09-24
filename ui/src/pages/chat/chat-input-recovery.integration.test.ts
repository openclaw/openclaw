/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatInputRecovery, sendChatRecoveryInput } from "./chat-input-recovery-actions.ts";
import { createChatInputRecoveryQueueProps } from "./chat-input-recovery-view.ts";
import { makeChatPageHost } from "./chat-pending-inputs.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession, subscribeChatOutboxProjection } from "./chat-queue.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const host = makeChatPageHost({
    sessionKey: "agent:main:queue-recovery",
    currentSessionId: "queue-recovery-physical",
    selfUser: { id: "viewer", name: "Viewer" },
    chatMessage: "Keep this draft",
    requestHandlers: {
      "chat.message.get": {
        ok: true,
        message: {
          role: "user",
          content: "Recovered full prompt",
          __openclaw: { id: "pending:saved" },
        },
      },
    },
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
  const props = createChatInputRecoveryQueueProps(host, true);
  expect(props?.items).toHaveLength(1);
  props?.onDiscard("saved");
  expect(listStoredChatOutboxes(host)).toEqual(before);
  expect(host.chatQueue).toEqual([]);
  expect(host.request).not.toHaveBeenCalled();
  expect(createChatInputRecoveryQueueProps(fixture(), true)).toBeUndefined();
});

it("keeps older attempts reachable after the latest recovery row is discarded", () => {
  const host = fixture();
  const saved = getChatInputRecovery(host).items;
  applyChatPendingInputs(host, { items: saved, total: 21, nextBefore: 100 });
  createChatInputRecoveryQueueProps(host, true)?.onDiscard("saved");
  const props = createChatInputRecoveryQueueProps(host, true);
  expect(props?.items).toEqual([]);
  expect(props?.paging?.onEarlier).toBeTypeOf("function");
  expect(host.request).not.toHaveBeenCalled();
  expect(host.chatQueue).toEqual([]);
});

it("keeps earlier-page navigation when only active custody is visible", () => {
  const host = fixture();
  const queued = { ...getChatInputRecovery(host).items[0]!, state: "queued" as const };
  applyChatPendingInputs(host, { items: [queued], total: 21, nextBefore: 100 });
  const props = createChatInputRecoveryQueueProps(host, true);
  expect(props?.items).toEqual([]);
  expect(props?.paging?.onEarlier).toBeTypeOf("function");
  expect(host.request).not.toHaveBeenCalled();
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
  const unsubscribe = subscribeChatOutboxProjection(host);
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
    createChatInputRecoveryQueueProps(host, true);
    await sendChatRecoveryInput(host, "saved");
    expect(host.chatQueue.slice(0, 2)).toEqual(before);
    expect(host.chatQueue).toHaveLength(3);
    expect(host.chatQueue[2]?.text).toBe("Recovered full prompt");
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

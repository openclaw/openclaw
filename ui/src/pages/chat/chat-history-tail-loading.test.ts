// @vitest-environment node
import { expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { dispatchChatSlashCommand } from "./chat-commands.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { historyMessage as message } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";

const delivery = vi.hoisted(() => ({
  attempts: 0,
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));
vi.mock("./chat-history-page-preparation.ts", async (original) => {
  delivery.attempts++;
  delivery.started.resolve();
  await delivery.release.promise;
  return original<typeof import("./chat-history-page-preparation.ts")>();
});

function obsoleteTail() {
  const source: { weak?: WeakRef<object> } = {};
  const host = makeChatHost({
    currentSessionId: "session",
    requestHandlers: {
      "chat.history": () => {
        const body = message("assistant", "Retired response", { id: "retired", seq: 9 });
        source.weak = new WeakRef(body);
        return { messages: [body], sessionId: "session", hasMore: false };
      },
    },
  });
  const pending = loadChatHistory(host);
  return {
    source,
    request: host.request,
    read: chatHistoryRequests(host).historyRead!,
    pending,
  };
}

it("releases an aborted tail before module delivery and publishes only current view facts", async () => {
  const incoming = message("assistant", "Tail", { id: "tail", seq: 5 });
  const fresh = makeChatHost({
    requestHandlers: {
      "chat.history": { messages: [incoming], sessionId: "session", hasMore: false },
    },
  });
  await loadChatHistory(fresh);
  expect(delivery.attempts).toBe(0);
  expect(fresh.chatMessages).toEqual([incoming]);

  const held = message("assistant", "Held", { id: "held", seq: 4 });
  const current = makeChatHost({
    renderLifecycle: { afterCommit: () => () => undefined },
    currentSessionId: "session",
    chatMessages: [held],
    requestHandlers: {
      "chat.history": { messages: [{ ...held }], sessionId: "session", hasMore: false },
    },
  });
  const hidden = makeChatHost({
    currentSessionId: "session",
    chatHistoryPagination: { hasMore: false, totalMessages: 4 },
    requestHandlers: {
      "chat.history": {
        messages: [incoming],
        sessionId: "session",
        hasMore: true,
        olderCursor: "raw-tail",
        nextOffset: 1,
        totalMessages: 5,
      },
    },
  });
  const retired = obsoleteTail();
  const loading = loadChatHistory(current);
  const hiddenLoading = loadChatHistory(hidden);
  try {
    await delivery.started.promise;
    retired.read.abort();
    await expect(retired.pending).resolves.toBeUndefined();
    retired.request.mockClear();
    const control = new WeakRef({ unowned: true });
    await collectGarbageForTest();
    expect(control.deref()).toBeUndefined();
    expect(retired.source.weak?.deref()).toBeUndefined();

    const restored = { ...held };
    const live = message("assistant", "Arrived during import", { id: "live", seq: 6 });
    reduceChatSessionProjection(current, { type: "snapshotLoaded", messages: [restored] });
    reduceChatSessionProjection(current, { type: "messagePersisted", message: live });
    await expect(dispatchChatSlashCommand(current, "help", "")).resolves.toBe("completed");
    const outputs = getChatSessionProjection(current).entries.filter((entry) => entry.localOutput);
    expect(outputs).toHaveLength(1);
    const output = outputs[0]?.message;
    expect(output).toBeDefined();
    delivery.release.resolve();
    await Promise.all([loading, hiddenLoading]);
    expect(current.chatMessages).toEqual([restored, live, output]);
    expect(current.chatMessages[0]).toBe(restored);
    expect(current.chatMessages[1]).toBe(live);
    expect(current.chatMessages.at(-1)).toBe(output);
    expect(
      getChatSessionProjection(current).entries.filter((entry) => entry.localOutput),
    ).toHaveLength(1);
    expect(hidden.chatMessages).toEqual([incoming]);
    expect(hidden.chatHistoryPagination).toMatchObject({ hasMore: false, totalMessages: 5 });
    expect(delivery.attempts).toBe(1);
  } finally {
    delivery.release.resolve();
    await Promise.allSettled([retired.pending, loading, hiddenLoading]);
  }
});

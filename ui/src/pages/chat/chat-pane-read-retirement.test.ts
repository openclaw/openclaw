/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { getChatHistoryLoadState, isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createNativeShowEarlierPane } from "./chat-pane-history.test-support.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane.test-support.ts";

function heldTranscriptPane() {
  const reads: {
    method: string;
    signal?: AbortSignal;
    response: ReturnType<typeof createDeferred<ReturnType<typeof history>>>;
  }[] = [];
  const client = createTestGatewayClient((method, _params, options) => {
    if (method !== "chat.startup" && method !== "chat.history") {
      return {};
    }
    const response = createDeferred<ReturnType<typeof history>>();
    reads.push({ method, signal: options?.signal, response });
    return response.promise;
  });
  const fixture = createTestChatPane({ client });
  onTestFinished(() => reads.forEach(({ response }) => response.resolve(history("cleanup"))));
  return { ...fixture, reads };
}

function history(text: string) {
  return { messages: [nativeHistoryMessage(1, text)], sessionId: "current-session" };
}

it("retires hidden startup and resumes authoritative admission without losing draft or viewport intent", async () => {
  const { pane, state, reads } = heldTranscriptPane();
  state.chatMessage = "Unsent draft";
  const attachments = state.chatAttachments;
  pane.transcriptScrollTop = 240;
  const pending = loadChatHistory(state, { startup: true, deferBranches: true });
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  expect(isInitialChatHistoryUnavailable(state)).toBe(true);
  pane.presented = false;
  expect(reads[0]!.signal?.aborted).toBe(true);
  await expect(pending).resolves.toBeUndefined();
  expect(getChatHistoryLoadState(state)).toMatchObject({
    phase: "pending-presentation",
    startup: true,
  });
  reads[0]!.response.resolve(history("Obsolete startup"));
  await Promise.resolve();
  expect(state.chatMessages).toEqual([]);
  expect(state.chatError).toBeNull();
  expect(state.chatMessage).toBe("Unsent draft");
  expect(state.chatAttachments).toBe(attachments);
  expect(pane.transcriptScrollTop).toBe(240);
  expect(pane.transcriptLoading).toBe(true);

  pane.presented = true;
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  expect(reads[1]!.method).toBe("chat.startup");
  expect(isInitialChatHistoryUnavailable(state)).toBe(true);
  reads[1]!.response.resolve(history("Current startup"));
  await vi.waitFor(() => expect(getChatHistoryLoadState(state).phase).toBe("committed"));
  expect(state.chatMessages).toEqual(history("Current startup").messages);
  expect(isInitialChatHistoryUnavailable(state)).toBe(false);
  expect(state.chatMessage).toBe("Unsent draft");
});

it("preserves paused startup when a new hidden custody refresh consumes its intent", async () => {
  const { pane, state, reads } = heldTranscriptPane();
  const pending = loadChatHistory(state, { startup: true, deferBranches: true });
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  pane.presented = false;
  expect(reads[0]!.signal?.aborted).toBe(true);
  await pending;
  const custody = loadChatHistory(state, { deferBranches: true, supersedeInFlight: true });
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  expect(reads[1]!.method).toBe("chat.startup");
  expect(isInitialChatHistoryUnavailable(state)).toBe(true);
  pane.presented = true;
  expect(reads).toHaveLength(2);
  reads[1]!.response.resolve(history("Custody startup"));
  await custody;
  expect(state.chatMessages).toEqual(history("Custody startup").messages);
  expect(isInitialChatHistoryUnavailable(state)).toBe(false);
});

it("retires an older read on hide and permits the same cursor again on reveal", async () => {
  const first = createDeferred<{
    messages: ReturnType<typeof nativeHistoryMessage>[];
    hasMore: boolean;
    totalMessages: number;
  }>();
  let signal: AbortSignal | undefined;
  const older = {
    messages: [1, 2].map((seq) => nativeHistoryMessage(seq)),
    hasMore: false,
    totalMessages: 4,
  };
  let attempts = 0;
  const request = vi.fn((method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
    if (method !== "chat.history") {
      return Promise.resolve({});
    }
    signal = options?.signal;
    return ++attempts === 1 ? first.promise : Promise.resolve(older);
  });
  const { pane, state, thread } = createNativeShowEarlierPane(request);
  onTestFinished(() => first.resolve(older));
  const messages = state.chatMessages;
  const pagination = state.chatHistoryPagination;
  thread.scrollTop = 120;
  const pending = pane.loadOlderMessages();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  pane.presented = false;
  expect(signal?.aborted).toBe(true);
  first.resolve(older);
  await expect(pending).resolves.toBe(false);
  expect(state.chatMessages).toBe(messages);
  expect(state.chatHistoryPagination).toBe(pagination);
  expect(thread.scrollTop).toBe(120);
  expect(state.chatError).toBeNull();
  pane.presented = true;
  await expect(pane.loadOlderMessages()).resolves.toBe(true);
  expect(
    request.mock.calls.filter(([method]) => method === "chat.history").map(([, params]) => params),
  ).toEqual([expect.objectContaining({ offset: 2 }), expect.objectContaining({ offset: 2 })]);
  expect(state.chatMessages).toEqual([...older.messages, ...messages]);
});

/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  input,
  makeChatPageHost,
  page,
  sessionId,
  sessionKey,
} from "./chat-pending-inputs.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { retireDeliveredQueuedUserTurn } from "./chat-send-support.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  resetTranscriptTestDom();
  vi.unstubAllGlobals();
});

it.each(["held", "failed"] as const)(
  "keeps native %s recovery visible unless the Gateway owns active custody",
  (sendState) => {
    const host = makeChatPageHost({ sessionKey, currentSessionId: sessionId, requestHandlers: {} });
    applyChatPendingInputs(host, page);
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
        id: "local-owner",
        text: "Complete local payload",
        createdAt: 100,
        sessionKey,
        sessionId,
        sendRunId: input.runId,
        sendAttempts: 1,
        sendState,
      }),
    ).toBe(true);
    const retry = vi.fn();
    const paint = () =>
      renderChatView({
        historyState: host,
        sessionKey,
        queue: host.chatQueue,
        onQueueRetry: retry,
        onQueueRemove: host.removeQueuedMessage,
      });
    const before = structuredClone(listStoredChatOutboxes(host));
    const recovered = paint();
    expect(recovered.querySelectorAll(".chat-send-status__retry")).toHaveLength(1);
    expect(recovered.textContent).toContain("Complete local payload");
    expect(recovered.textContent).not.toContain("Keep my accepted input");
    recovered.querySelector<HTMLButtonElement>(".chat-send-status__retry")!.click();
    expect(retry).toHaveBeenCalledExactlyOnceWith("local-owner");

    // Active snapshots supersede retained pages without dropping native retry bytes.
    const active = { ...input, state: "queued" as const };
    applyChatPendingInputs(host, {
      items: [],
      total: 21,
      nextBefore: 21,
      queuedCount: 0,
      queue: { items: [active] },
    });
    expect(paint().querySelector(".chat-send-status__retry")).toBeNull();
    expect(paint().textContent).toContain("Keep my accepted input");
    expect(listStoredChatOutboxes(host)).toEqual(before);

    applyChatPendingInputs(host, page);
    const interrupted = paint();
    expect(interrupted.querySelectorAll(".chat-send-status__retry")).toHaveLength(1);
    interrupted.querySelector<HTMLButtonElement>(".chat-send-status__discard")!.click();
    expect(host.chatQueue).toEqual([]);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(paint().textContent).toContain("Keep my accepted input");
    expect(paint().querySelector(".chat-send-status__retry")).toBeNull();
    expect(host.request).not.toHaveBeenCalled();
  },
);

it("does not duplicate an off-page active input when delivered display arrives late", async () => {
  const host = makeChatHost({ sessionKey, currentSessionId: sessionId });
  const activeInput = {
    id: "accepted",
    runId: "original-run",
    acceptedAt: 100,
    state: "queued" as const,
    message: {
      role: "user",
      content: "One accepted prompt",
      __openclaw: { id: "pending:accepted" },
    },
  };
  applyChatPendingInputs(host, {
    items: [],
    total: 21,
    nextBefore: 20,
    queue: { items: [activeInput] },
  });
  const rows = () =>
    [
      ...renderChatView({
        historyState: host,
        sessionKey,
        messages: host.chatMessages,
        queue: host.chatQueue,
      }).querySelectorAll<HTMLElement>(".chat-bubble"),
    ].map((row) => row.dataset.messageText);
  expect(rows()).toEqual(["One accepted prompt"]);
  expect(
    admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
      id: "late-local",
      sendRunId: activeInput.runId,
      sessionKey,
      sessionId,
      text: "One accepted prompt",
      createdAt: 100,
    }),
  ).toBe(true);
  const outbox = listStoredChatOutboxes(host)[0]!;
  expect(await retireDeliveredQueuedUserTurn(host, activeInput.runId, outbox)).toBe("retired");
  expect(rows()).toEqual(["One accepted prompt"]);
});

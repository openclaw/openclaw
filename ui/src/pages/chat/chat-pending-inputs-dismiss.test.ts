/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatPendingInputsDismissResult,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { createTestTranscript, renderChatInto, renderChatView } from "./chat-view.test-helpers.ts";
import type { ChatProps } from "./chat-view.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
} from "./components/chat-transcript.test-support.ts";

type PageItem = ChatPendingInputsPage["items"][number];

const sessionKey = "agent:main:retired-inputs";
const sessionId = "retired-input-session";
const retained = (
  id: string,
  state: PageItem["state"],
  content: unknown,
  acceptedAt: number,
): PageItem => ({
  id,
  runId: `${id}-run`,
  acceptedAt,
  state,
  message: { role: "user", content, timestamp: acceptedAt },
});
const page: ChatPendingInputsPage = {
  total: 2,
  items: [
    retained("first-input", "cancelled", "Draft the release notes", 100),
    retained("cancelled-input", "cancelled", "Rename the staging bucket", 101),
  ],
};
const tombstone = (input: PageItem): PageItem => ({
  ...input,
  state: "cancelled",
  message: { role: "user", content: [], display: false, timestamp: input.acceptedAt },
});
const dismissed = (ids: string[], missingIds: string[] = []): ChatPendingInputsDismissResult => ({
  dismissedIds: ids,
  runIds: ids.map((id) => `${id}-run`),
  missingIds,
});

const admitCopy = (
  host: ReturnType<typeof makeChatHost>,
  id: string,
  sendRunId: string,
  extra: Partial<ChatQueueItem> = {},
) =>
  expect(
    admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
      id,
      sendRunId,
      sessionKey,
      text: id,
      createdAt: 1,
      ...extra,
    }),
  ).toBe(true);

beforeEach(() => {
  installTranscriptDomMocks();
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(resetTranscriptTestDom);

async function setup(
  dismiss: (
    params: unknown,
  ) => ChatPendingInputsDismissResult | Promise<ChatPendingInputsDismissResult>,
  options: {
    canSend?: boolean;
    canDismissPendingInputs?: boolean;
    retained?: ChatPendingInputsPage;
    noticeCount?: number;
  } = {},
) {
  const initial = options.retained ?? page;
  const historyState = makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.pendingInputs.dismiss": dismiss,
      // An overlapping refresh may still return the pre-dismissal page.
      "chat.history": () => ({ sessionId, pendingInputs: initial }),
    },
  });
  applyChatPendingInputs(historyState, initial);
  const transcript = createTestTranscript();
  const overrides: Partial<ChatProps> = {
    transcript,
    historyState,
    sessionKey,
    messages: [{ role: "assistant", content: "Earlier reply", timestamp: 50 }],
    canSend: options.canSend ?? true,
    canDismissPendingInputs: options.canDismissPendingInputs ?? true,
  };
  const container = renderChatView(overrides);
  const viewport = transcript.scrollElement!;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 600 });
  for (const observer of resizeObservers) {
    observer.emitTarget(viewport, 800, 600);
  }
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".chat-notice")).toHaveLength(
      options.noticeCount ?? initial.items.length,
    ),
  );
  const rerender = (messages = overrides.messages) =>
    renderChatInto(container, { ...overrides, messages });
  const named = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const expectDismiss = (inputIds: string[]) =>
    expect(historyState.request).toHaveBeenCalledWith("chat.pendingInputs.dismiss", {
      sessionKey,
      agentId: "main",
      sessionId,
      inputIds,
    });
  const refreshed = () =>
    vi.waitFor(() =>
      expect(historyState.request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey }),
      ),
    );
  return {
    historyState,
    container,
    rerender,
    named,
    admitCopy: (id: string, runId: string) => admitCopy(historyState, id, runId),
    expectDismiss,
    refreshed,
    outboxIds: () => listStoredChatOutboxes(historyState).flatMap((o) => o.queue.map((i) => i.id)),
    text: () => container.textContent ?? "",
    hasRow: (id: string) =>
      container.querySelector(`[data-chat-row-key="pending-input:${id}:state"]`) !== null,
    dismissButtons: () => container.querySelectorAll(".chat-notice button[aria-label^='Dismiss ']"),
    rowButton: (label: string) => expectDefined(named(label), label),
  };
}

const firstLabel = "Dismiss unsent message: Draft the release notes";
const cancelledLabel = "Dismiss unsent message: Rename the staging bucket";

describe("cancelled pending input dismissal", () => {
  it("keeps individual dismissal available to a writer when sending is unavailable", async () => {
    const writer = await setup(() => dismissed([]), { canSend: false });
    expect(writer.dismissButtons()).toHaveLength(2);
    expect(writer.named(firstLabel)).not.toBeNull();
    expect(writer.text()).not.toContain("Dismiss all");
    const viewer = await setup(() => dismissed([]), { canDismissPendingInputs: false });
    expect(viewer.dismissButtons()).toHaveLength(0);
  });

  it("hides a dismissed row at once and keeps it hidden after the Gateway confirms", async () => {
    const reply = createDeferred<ChatPendingInputsDismissResult>();
    const view = await setup(() => reply.promise);
    view.rowButton(firstLabel).click();
    view.rerender();
    expect(view.hasRow("first-input")).toBe(false);
    expect(view.hasRow("cancelled-input")).toBe(true);
    view.expectDismiss(["first-input"]);
    reply.resolve(dismissed(["first-input"]));
    await view.refreshed();
    applyChatPendingInputs(view.historyState, page);
    view.rerender();
    expect(view.hasRow("first-input")).toBe(false);
    expect(view.dismissButtons()).toHaveLength(1);
  });

  it("restores only the row whose dismissal failed", async () => {
    const first = createDeferred<ChatPendingInputsDismissResult>();
    const second = createDeferred<ChatPendingInputsDismissResult>();
    const view = await setup((params) =>
      (params as { inputIds: string[] }).inputIds[0] === "first-input"
        ? first.promise
        : second.promise,
    );
    view.rowButton(firstLabel).click();
    view.rowButton(cancelledLabel).click();
    view.rerender();
    expect(view.dismissButtons()).toHaveLength(0);
    first.reject(new Error("Dismissal failed"));
    await vi.waitFor(() => {
      view.rerender();
      expect(view.text()).toContain("Dismissal failed");
    });
    expect(view.hasRow("first-input")).toBe(true);
    expect(view.hasRow("cancelled-input")).toBe(false);
    second.resolve(dismissed(["cancelled-input"]));
    await view.refreshed();
  });

  it("does not retire a replacement connection's outbox from a stale dismissal", async () => {
    const reply = createDeferred<ChatPendingInputsDismissResult>();
    const view = await setup(() => reply.promise);
    view.admitCopy("replacement-copy", "first-input-run");
    view.rowButton(firstLabel).click();
    view.historyState.client = createTestGatewayClient(view.historyState.request);
    reply.resolve(dismissed(["first-input"]));
    await vi.waitFor(() => expect(view.historyState.chatPendingInputs?.dismissing?.size).toBe(0));
    expect(view.outboxIds()).toEqual(["replacement-copy"]);
  });

  it("does not resend a copy after history confirms another client dismissed it", async () => {
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": () => ({
          sessionId,
          messages: [],
          pendingInputs: { total: 1, items: [tombstone(page.items[0]!)] },
          inputReceipts: [{ runId: "first-input-run", state: "pending", cancelled: true }],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        }),
      },
    });
    admitCopy(host, "stale-copy", "first-input-run", {
      sessionId,
      sendAttempts: 1,
      sendState: "waiting-reconnect",
    });
    await loadChatHistory(host);
    await resumeStoredChatOutboxes(host);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });
});

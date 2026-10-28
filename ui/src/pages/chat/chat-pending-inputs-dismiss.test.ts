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
    retained("interrupted-input", "interrupted", "Draft the release notes", 100),
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

const dismissAllLabel = "Dismiss all interrupted and cancelled messages shown";
const interruptedLabel = "Dismiss interrupted message: Draft the release notes";
const cancelledLabel = "Dismiss cancelled message: Rename the staging bucket";

describe("retired pending input dismissal", () => {
  it("does not offer bulk dismissal for inputs already represented in history", async () => {
    const view = await setup(() => dismissed([]));
    view.rerender(
      page.items.map((input) => ({
        role: "user",
        content: "Already in the conversation",
        __openclaw: { id: input.id },
      })),
    );
    expect(view.dismissButtons()).toHaveLength(0);
    expect(view.named(dismissAllLabel)).toBeNull();
    expect(view.text()).toContain("Already in the conversation");
  });

  it("uses the live search projection for both bulk visibility and request targets", async () => {
    const view = await setup(() => dismissed(["interrupted-input"]));
    expectDefined(view.container.querySelector(".chat"), "chat").dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
    );
    const search = await vi.waitFor(() =>
      expectDefined(
        view.container.querySelector<HTMLInputElement>(".agent-chat__search-bar input"),
        "transcript search",
      ),
    );
    search.value = "no matching input";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(view.dismissButtons()).toHaveLength(0));
    expect(view.named(dismissAllLabel)).toBeNull();
    search.value = "release notes";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(view.dismissButtons()).toHaveLength(1));
    view.rowButton(dismissAllLabel).click();
    view.rerender();
    view.expectDismiss(["interrupted-input"]);
    expect(view.named(dismissAllLabel)).toBeNull();
    await view.refreshed();
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(view.named(cancelledLabel)).not.toBeNull());
    expect(view.named(dismissAllLabel)).not.toBeNull();
  });

  it("hides every dismissal control from a viewer who cannot mutate the session", async () => {
    const view = await setup(() => dismissed([]), { canDismissPendingInputs: false });
    expect(view.hasRow("interrupted-input")).toBe(true);
    expect(view.dismissButtons()).toHaveLength(0);
    expect(view.named(dismissAllLabel)).toBeNull();
  });

  it("lets a writer dismiss while sending is unavailable", async () => {
    const view = await setup(() => dismissed([]), {
      canSend: false,
      noticeCount: 2,
      retained: {
        total: 4,
        items: [
          ...page.items,
          tombstone(retained("hidden", "cancelled", "Hidden", 102)),
          retained("future", "queued", "Future", 103),
        ],
      },
    });
    expect(view.dismissButtons()).toHaveLength(2);
    expect(view.named(interruptedLabel)).not.toBeNull();
    expect(view.named(cancelledLabel)).not.toBeNull();
    expect(view.named(dismissAllLabel)?.textContent?.trim()).toBe("Dismiss all");
  });

  it("names text-less inputs by their attachments or image count", async () => {
    const view = await setup(() => dismissed([]), {
      retained: {
        total: 1,
        items: [
          retained(
            "image-input",
            "interrupted",
            [{ type: "image", source: { type: "url", url: "https://example.com/proof.png" } }],
            100,
          ),
        ],
      },
    });
    expect(view.named("Dismiss interrupted message: Image (1)")).not.toBeNull();
  });

  it.each(["single", "bulk", "missing"] as const)(
    "optimistically hides %s dismissal through page replacement and confirmation",
    async (mode) => {
      const ids =
        mode === "bulk" ? ["interrupted-input", "cancelled-input"] : ["interrupted-input"];
      const reply = createDeferred<ChatPendingInputsDismissResult>();
      const view = await setup(() => reply.promise);
      view.admitCopy("browser-copy", "interrupted-input-run");
      view.rowButton(mode === "bulk" ? dismissAllLabel : interruptedLabel).click();
      view.rerender();
      expect(view.hasRow("interrupted-input")).toBe(false);
      expect(view.hasRow("cancelled-input")).toBe(mode !== "bulk");
      view.expectDismiss(ids);
      applyChatPendingInputs(view.historyState, {
        total: 3,
        items: [
          ...page.items.map((input) => ({ ...input })),
          retained("newer-input", "interrupted", "Check the deploy logs", 102),
        ],
      });
      view.rerender();
      expect(view.hasRow("interrupted-input")).toBe(false);
      expect(view.hasRow("cancelled-input")).toBe(mode !== "bulk");
      expect(view.hasRow("newer-input")).toBe(true);
      reply.resolve(mode === "missing" ? dismissed([], ids) : dismissed(ids));
      await view.refreshed();
      view.rerender();
      expect(view.hasRow("interrupted-input")).toBe(false);
      expect(view.hasRow("cancelled-input")).toBe(mode !== "bulk");
      expect(view.dismissButtons()).toHaveLength(mode === "bulk" ? 0 : 1);
      if (mode !== "missing") {
        expect(view.outboxIds()).toEqual([]);
      }
    },
  );

  it("restores only the rows of the request that failed", async () => {
    const replies = new Map([
      ["interrupted-input", createDeferred<ChatPendingInputsDismissResult>()],
      ["cancelled-input", createDeferred<ChatPendingInputsDismissResult>()],
    ]);
    const view = await setup((params) => {
      const [id] = (params as { inputIds: string[] }).inputIds;
      return expectDefined(replies.get(id!), "reply").promise;
    });
    view.rowButton(interruptedLabel).click();
    view.rowButton(cancelledLabel).click();
    view.rerender();
    expect(view.dismissButtons()).toHaveLength(0);
    replies
      .get("interrupted-input")!
      .reject(new Error("Only interrupted or cancelled pending inputs can be dismissed"));
    await vi.waitFor(() => {
      view.rerender();
      expect(view.text()).toContain("Only interrupted or cancelled pending inputs");
    });
    expect(view.hasRow("interrupted-input")).toBe(true);
    expect(view.hasRow("cancelled-input")).toBe(false);
    replies.get("cancelled-input")!.resolve(dismissed(["cancelled-input"]));
    await view.refreshed();
    view.rerender();
    expect(view.hasRow("cancelled-input")).toBe(false);
    expect(view.dismissButtons()).toHaveLength(1);
  });

  it.each(["route", "connection"])(
    "settles outbox copies only for their owning %s",
    async (change) => {
      const reply = createDeferred<ChatPendingInputsDismissResult>();
      const view = await setup(() => reply.promise);
      view.admitCopy("browser-copy", "interrupted-input-run");
      view.admitCopy("other-device-copy", "cancelled-input-run");
      view.admitCopy("unrelated", "other-run");
      view.rowButton(dismissAllLabel).click();
      if (change === "route") {
        view.historyState.sessionKey = "agent:main:another-conversation";
      } else {
        view.historyState.client = createTestGatewayClient(view.historyState.request);
      }
      reply.resolve(dismissed(["interrupted-input", "cancelled-input"]));
      await vi.waitFor(() => {
        expect(view.outboxIds()).toEqual(
          change === "route" ? ["unrelated"] : ["browser-copy", "other-device-copy", "unrelated"],
        );
        if (change === "connection") {
          expect(view.historyState.chatPendingInputs?.dismissing?.size).toBe(0);
        }
      });
    },
  );

  it("does not resend a copy after history confirms another client dismissed it", async () => {
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": () => ({
          sessionId,
          messages: [],
          pendingInputs: { total: 1, items: [tombstone(page.items[0]!)] },
          inputReceipts: [{ runId: "interrupted-input-run", state: "pending", cancelled: true }],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        }),
      },
    });
    admitCopy(host, "stale-copy", "interrupted-input-run", {
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

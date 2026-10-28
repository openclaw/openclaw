/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatPendingInputsDismissResult,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import {
  createTestTranscript,
  disposeChatView,
  renderChatInto,
  renderChatView,
} from "./chat-view.test-helpers.ts";
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

const containers: HTMLElement[] = [];
beforeEach(() => {
  installTranscriptDomMocks();
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  containers.splice(0).forEach(disposeChatView);
  resetTranscriptTestDom();
});

async function setup(
  dismiss: (
    params: unknown,
  ) => ChatPendingInputsDismissResult | Promise<ChatPendingInputsDismissResult>,
  options: {
    canSend?: boolean;
    canDismissPendingInputs?: boolean;
    retained?: ChatPendingInputsPage;
    messages?: unknown[];
    noticeCount?: number;
  } = {},
) {
  const initial = options.retained ?? page;
  const serverDismissed = new Set<string>();
  const historyState = makeChatHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.pendingInputs.dismiss": async (params: unknown) => {
        const result = await dismiss(params);
        result.dismissedIds.forEach((id) => serverDismissed.add(id));
        return result;
      },
      "chat.history": () => ({
        sessionId,
        pendingInputs: {
          ...initial,
          items: initial.items.map((input) =>
            serverDismissed.has(input.id) ? tombstone(input) : input,
          ),
        },
      }),
    },
  });
  applyChatPendingInputs(historyState, initial);
  const transcript = createTestTranscript();
  const overrides = {
    transcript,
    historyState,
    sessionKey,
    messages: options.messages ?? [{ role: "assistant", content: "Earlier reply", timestamp: 50 }],
    ...(options.canSend === undefined ? {} : { canSend: options.canSend }),
    ...(options.canDismissPendingInputs === undefined
      ? {}
      : { canDismissPendingInputs: options.canDismissPendingInputs }),
  };
  const container = renderChatView(overrides);
  containers.push(container);
  const viewport = transcript.scrollElement!;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 600 });
  for (const observer of resizeObservers) {
    observer.emitTarget(viewport, 800, 600);
  }
  await vi.dynamicImportSettled();
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".chat-notice")).toHaveLength(
      options.noticeCount ?? initial.items.length,
    ),
  );
  const rerender = () => renderChatInto(container, overrides);
  const named = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const admitCopy = (id: string, sendRunId: string, extra: Record<string, unknown> = {}) =>
    expect(
      admitQueuedMessageForSession(
        historyState,
        captureChatOutboxAdmission(historyState, sessionKey, undefined),
        { id, sendRunId, sessionKey, text: id, createdAt: 1, ...extra },
      ),
    ).toBe(true);
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
    admitCopy,
    expectDismiss,
    refreshed,
    outboxIds: () => listStoredChatOutboxes(historyState).flatMap((o) => o.queue.map((i) => i.id)),
    text: () => container.textContent ?? "",
    hasRow: (id: string) =>
      container.querySelector(`[data-chat-row-key="pending-input:${id}:state"]`) !== null,
    dismissButtons: () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => button.textContent?.trim() === "Dismiss",
      ),
    rowButton: (label: string) => expectDefined(named(label), label),
  };
}

const dismissAllLabel = "Dismiss all interrupted and cancelled messages shown";
const interruptedLabel = "Dismiss interrupted message: Draft the release notes";
const cancelledLabel = "Dismiss cancelled message: Rename the staging bucket";

describe("retired pending input dismissal", () => {
  it("does not offer bulk dismissal for inputs already represented in history", async () => {
    const view = await setup(() => dismissed([]), {
      messages: page.items.map((input) => ({
        role: "user",
        content: "Already in the conversation",
        __openclaw: { id: input.id },
      })),
      noticeCount: 0,
    });
    expect(view.dismissButtons()).toHaveLength(0);
    expect(view.named(dismissAllLabel)).toBeNull();
    expect(view.text()).toContain("Already in the conversation");
  });

  it("bulk dismisses only search-visible rows and restores them after failure", async () => {
    const reply = createDeferred<ChatPendingInputsDismissResult>();
    const view = await setup(() => reply.promise);
    expectDefined(view.container.querySelector(".chat"), "chat").dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
    );
    await vi.waitFor(() =>
      expect(view.container.querySelector(".agent-chat__search-bar input")).not.toBeNull(),
    );
    const search = expectDefined(
      view.container.querySelector<HTMLInputElement>(".agent-chat__search-bar input"),
      "transcript search",
    );
    search.value = "release notes";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(view.dismissButtons()).toHaveLength(1));
    view.rowButton(dismissAllLabel).click();
    view.rerender();
    view.expectDismiss(["interrupted-input"]);
    expect(view.named(dismissAllLabel)).toBeNull();
    reply.reject(new Error("Dismissal unavailable"));
    await vi.waitFor(() => {
      view.rerender();
      expect(view.text()).toContain("Dismissal unavailable");
      expect(view.named(interruptedLabel)).not.toBeNull();
    });
    search.value = "no matching input";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(view.dismissButtons()).toHaveLength(0));
    expect(view.named(dismissAllLabel)).toBeNull();
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(view.dismissButtons()).toHaveLength(2));
    expect(view.named(dismissAllLabel)).not.toBeNull();
  });

  it("hides every dismissal control from a viewer who cannot mutate the session", async () => {
    const view = await setup(() => dismissed([]), { canDismissPendingInputs: false });
    expect(view.hasRow("interrupted-input")).toBe(true);
    expect(view.dismissButtons()).toHaveLength(0);
    expect(view.named(dismissAllLabel)).toBeNull();
  });

  it("lets a writer dismiss while sending is unavailable", async () => {
    const view = await setup(() => dismissed([]), { canSend: false });
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

  it("excludes hidden, queued, canonical, and non-dismissable notice projections from a batch", async () => {
    const canonical = retained("canonical-input", "cancelled", "Already saved", 102);
    const steer = retained("steered-input", "interrupted", "Already steered", 103);
    const modelChange = {
      ...retained("model-change", "interrupted", "", 104),
      message: {
        role: "custom",
        customType: "session-model-change",
        details: { from: "example/old", to: "example/new" },
      },
    };
    const view = await setup(() => dismissed(["interrupted-input", "cancelled-input"]), {
      retained: {
        total: 7,
        items: [
          ...page.items,
          canonical,
          steer,
          modelChange,
          tombstone(retained("dismissed-input", "cancelled", "Already dismissed", 105)),
          { ...retained("queued-input", "queued", "Future request", 106), queued: true },
        ],
      },
      messages: [
        { role: "user", content: "Already saved", __openclaw: { id: canonical.id } },
        {
          role: "user",
          content: "Already steered",
          __openclaw: { idempotencyKey: steer.runId, steerTargetRunId: "original-run" },
        },
      ],
      noticeCount: 3,
    });
    expect(view.dismissButtons()).toHaveLength(2);
    view.rowButton(dismissAllLabel).click();
    view.expectDismiss(["interrupted-input", "cancelled-input"]);
  });

  it("hides a dismissed row at once and keeps it hidden after the Gateway confirms", async () => {
    const reply = createDeferred<ChatPendingInputsDismissResult>();
    const view = await setup(() => reply.promise);
    view.rowButton(interruptedLabel).click();
    view.rerender();
    expect(view.hasRow("interrupted-input")).toBe(false);
    expect(view.hasRow("cancelled-input")).toBe(true);
    view.expectDismiss(["interrupted-input"]);
    reply.resolve(dismissed(["interrupted-input"]));
    await view.refreshed();
    applyChatPendingInputs(view.historyState, page);
    view.rerender();
    expect(view.hasRow("interrupted-input")).toBe(false);
    expect(view.dismissButtons()).toHaveLength(1);
  });

  it("dismisses exactly the displayed rows from the footer", async () => {
    const view = await setup(() => dismissed(["interrupted-input", "cancelled-input"]));
    view.rowButton(dismissAllLabel).click();
    view.rerender();
    expect(view.hasRow("interrupted-input")).toBe(false);
    expect(view.hasRow("cancelled-input")).toBe(false);
    expect(view.named(dismissAllLabel)).toBeNull();
    view.expectDismiss(["interrupted-input", "cancelled-input"]);
  });

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

  it("treats an input the Gateway no longer retains as done", async () => {
    const view = await setup(() => dismissed([], ["cancelled-input"]));
    view.rowButton(cancelledLabel).click();
    await view.refreshed();
    view.rerender();
    expect(view.hasRow("cancelled-input")).toBe(false);
    expect(view.text()).not.toContain("Error");
  });

  it("retires browser copies by the Gateway's run ids even after the view moved on", async () => {
    const reply = createDeferred<ChatPendingInputsDismissResult>();
    const view = await setup(() => reply.promise);
    view.admitCopy("browser-copy", "interrupted-input-run");
    view.admitCopy("other-device-copy", "cancelled-input-run");
    view.admitCopy("unrelated", "other-run");
    view.rowButton(dismissAllLabel).click();
    view.historyState.sessionKey = "agent:main:another-conversation";
    reply.resolve(dismissed(["interrupted-input", "cancelled-input"]));
    await vi.waitFor(() => expect(view.outboxIds()).toEqual(["unrelated"]));
  });

  it("does not retire a replacement connection's outbox from a stale dismissal", async () => {
    const reply = createDeferred<ChatPendingInputsDismissResult>();
    const view = await setup(() => reply.promise);
    view.admitCopy("replacement-copy", "interrupted-input-run");
    view.rowButton(interruptedLabel).click();
    view.historyState.client = createTestGatewayClient(view.historyState.request);
    reply.resolve(dismissed(["interrupted-input"]));
    await vi.waitFor(() => expect(view.historyState.chatPendingInputs?.dismissing?.size).toBe(0));
    expect(view.outboxIds()).toEqual(["replacement-copy"]);
  });

  it("keeps a pending dismissal through a history refresh that replaces the page", async () => {
    const reply = createDeferred<ChatPendingInputsDismissResult>();
    const view = await setup(() => reply.promise);
    view.admitCopy("browser-copy", "interrupted-input-run");
    view.rowButton(dismissAllLabel).click();
    applyChatPendingInputs(view.historyState, {
      total: 3,
      items: [
        ...page.items.map((input) => ({ ...input })),
        retained("newer-input", "interrupted", "Check the deploy logs", 102),
      ],
    });
    view.rerender();
    expect(view.hasRow("interrupted-input")).toBe(false);
    expect(view.hasRow("cancelled-input")).toBe(false);
    expect(view.hasRow("newer-input")).toBe(true);
    reply.resolve(dismissed(["interrupted-input", "cancelled-input"]));
    await vi.waitFor(() => expect(view.outboxIds()).toEqual([]));
    view.rerender();
    expect(view.hasRow("interrupted-input")).toBe(false);
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
          inputReceipts: [{ runId: "interrupted-input-run", state: "pending", cancelled: true }],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        }),
      },
    });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
        id: "stale-copy",
        sendRunId: "interrupted-input-run",
        sessionKey,
        sessionId,
        text: "Draft the release notes",
        createdAt: 100,
        sendAttempts: 1,
        sendState: "waiting-reconnect",
      }),
    ).toBe(true);
    await loadChatHistory(host);
    await resumeStoredChatOutboxes(host);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });
});

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
import { applyChatPendingInputs, buildPendingInputItems } from "./chat-pending-inputs.ts";
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
    messages: [{ role: "assistant", content: "Earlier reply", timestamp: 50 }],
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
    expect(container.querySelectorAll(".chat-notice")).toHaveLength(initial.items.length),
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

  it("marks only visible retired custody as dismissable", () => {
    const items = buildPendingInputItems(
      [
        ...page.items,
        tombstone(retained("dismissed-input", "cancelled", "Already dismissed", 102)),
        retained("queued-input", "queued", "Summarize the open pull requests", 103),
      ],
      [],
    );
    expect(
      items.flatMap((item) =>
        item.kind === "notice" && item.retiredPendingInput ? [item.retiredPendingInput] : [],
      ),
    ).toEqual([
      { id: "interrupted-input", status: "interrupted", preview: "Draft the release notes" },
      { id: "cancelled-input", status: "cancelled", preview: "Rename the staging bucket" },
    ]);
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

/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("retained input navigation", () => {
  it("keeps an empty filtered page navigable without blocking an independent send", async () => {
    const sessionKey = "agent:main:hidden-page";
    const sessionId = "hidden-page-session";
    const olderPage = {
      total: 21,
      items: [
        {
          id: "older-visible",
          acceptedAt: 1,
          state: "interrupted" as const,
          message: { role: "user", content: "Older visible input" },
        },
      ],
    };
    const historyState = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: { "chat.history": () => ({ sessionId, pendingInputs: olderPage }) },
    });
    applyChatPendingInputs(historyState, { total: 21, items: [], nextBefore: 2 });
    const onSend = vi.fn();
    const container = renderChatView({
      historyState,
      sessionKey,
      draft: "Independent work",
      getDraft: () => "Independent work",
      onSend,
    });
    const earlier = expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes(t("chat.pendingInputs.earlier")),
      ),
      "earlier pending-input navigation",
    );
    expect(earlier.disabled).toBe(false);
    const send = expectDefined(
      container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
      "send button",
    );
    expect(send.disabled).toBe(false);
    send.click();
    expect(onSend).toHaveBeenCalledOnce();
    earlier.click();
    await vi.waitFor(() => expect(getChatPendingInputs(historyState)?.page).toEqual(olderPage));
    expect(historyState.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 2 }),
    );
    expect(historyState.chatMessages).toEqual([]);
  });

  it("hides the retained queue copy represented by pending custody without hiding an identical new send", async () => {
    const historyState = makeChatHost({ currentSessionId: "retained-input-session" });
    const message = {
      role: "user",
      content: "Check the deployment notes",
      timestamp: 100,
      idempotencyKey: "retained-run:user",
    };
    applyChatPendingInputs(historyState, {
      total: 1,
      items: [
        {
          id: "retained-input",
          runId: "retained-run",
          acceptedAt: 100,
          state: "queued",
          message,
        },
      ],
    });
    const queue = ["before", "retained", "new"].map((id, index) => ({
      id,
      text: message.content,
      createdAt: 100 + index,
      sendRunId: `${id}-run`,
      sendState: "waiting-reconnect" as const,
    }));
    const onQueueRemove = vi.fn();
    const onQueueMove = vi.fn();
    const container = renderChatView({
      historyState,
      messages: [],
      queue,
      onQueueRemove,
      onQueueMove,
    });

    // The queue mounts through a lazy boundary on first use.
    const rows = await waitForSolid(() => {
      const items = container.querySelectorAll(".chat-queue__item");
      expect([...items].map((row) => row.getAttribute("data-chat-queue-item"))).toEqual([
        "before",
        "new",
      ]);
      return items;
    });
    const grips = [...container.querySelectorAll<HTMLButtonElement>(".chat-queue__grip")];
    expect(grips).toHaveLength(2);
    expect(grips.every((grip) => grip.disabled)).toBe(true);
    grips[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onQueueMove).not.toHaveBeenCalled();
    rows[1]?.querySelector<HTMLButtonElement>(".chat-queue__remove")?.click();
    expect(onQueueRemove).toHaveBeenCalledWith("new");
    expect(queue).toHaveLength(3);
  });
});

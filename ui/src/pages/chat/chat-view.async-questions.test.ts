/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession, removeQueuedMessage } from "./chat-queue.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import { getTranscriptState } from "./components/chat-thread-interactions.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";

const container = document.createElement("div");
const audience = {
  role: "assistant",
  content: "Which audience?",
  openclawAsyncDelivery: {
    itemId: "audience",
    questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
  },
};
const terminal = (runId: string) => ({
  role: "assistant",
  runId,
  content: "Finished.",
  phase: "final_answer",
  __openclaw: { runTerminal: true },
});
beforeEach(() => {
  installTranscriptDomMocks();
  document.body.append(container);
});
afterEach(() => {
  render(null, container);
  container.remove();
  resetChatViewState();
  resetTranscriptTestDom();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "keeps the edited docked answer current when later work completes=%s",
  async (laterWork) => {
    const submit = vi.fn(async () => true);
    const question = laterWork
      ? {
          ...audience,
          runId: "old-run",
          openclawAsyncDelivery: {
            itemId: "audience",
            questions: [{ title: "Which audience?", options: ["Everyone"] }],
          },
        }
      : audience;
    const props = createChatProps({
      sessionKey: "agent:main:main",
      messages: [question],
      onAsyncQuestionSubmit: submit,
      onRequestUpdate: () => render(renderChat(props), container),
    });
    render(renderChat(props), container);
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-question-panel__other")).not.toBeNull(),
    );
    const answer = container.querySelector<HTMLInputElement>(".chat-question-panel__other")!;
    answer.value = "New contributors";
    answer.dispatchEvent(new Event("input", { bubbles: true }));
    if (laterWork) {
      props.messages = [question, terminal("old-run"), terminal("later-run")];
      render(renderChat(props), container);
      expect(container.querySelector(".agent-chat__question-dock")).not.toBeNull();
      expect(
        container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          ".chat-question-panel__other",
        )?.value,
      ).toBe("New contributors");
      return;
    }
    await Promise.resolve();
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledExactlyOnceWith(
        "> Which audience?\n\nNew contributors",
        "audience",
        undefined,
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector(".agent-chat__question-dock")).toBeNull(),
    );
    expect(container.querySelector(".chat-question-summary")?.textContent).toContain(
      "New contributors",
    );
  },
);

it("selects a reopened historical question ahead of another pending request", async () => {
  const old = { ...audience, runId: "old-run" };
  const latest = {
    role: "assistant",
    runId: "latest-run",
    content: "Which format?",
    openclawAsyncDelivery: {
      itemId: "format",
      questions: [{ title: "Which format?", options: ["Short", "Detailed"] }],
    },
  };
  const props = createChatProps({
    sessionKey: "agent:main:main",
    messages: [old],
    onAsyncQuestionSubmit: vi.fn(async () => true),
    onRequestUpdate: () => render(renderChat(props), container),
  });
  const draw = () => render(renderChat(props), container);
  draw();
  await vi.waitFor(() =>
    expect(container.querySelector(".chat-question-panel__other")).not.toBeNull(),
  );
  props.messages = [old, terminal("old-run"), latest, terminal("latest-run")];
  draw();
  await vi.waitFor(() =>
    expect(container.querySelector(".agent-chat__question-dock")?.textContent).toContain(
      "Which format?",
    ),
  );
  const summary = [...container.querySelectorAll<HTMLElement>(".chat-question-summary")].find(
    (element) => element.textContent?.includes("Which audience?"),
  )!;
  expect(summary.textContent).toContain("No longer pending");
  summary.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() =>
    expect(container.querySelector(".agent-chat__question-dock")?.textContent).toContain(
      "Which audience?",
    ),
  );
  expect(container.querySelector<HTMLInputElement>(".chat-question-panel__other")?.value).toBe("");
});

it("refreshes a mounted question summary when a canonical answer appears or is replaced", () => {
  const question = { ...audience, __openclaw: { id: "audience-question", seq: 1 } };
  const answer = {
    role: "user",
    content: "> Which audience?\n\nEveryone",
    __openclaw: { id: "audience-answer", seq: 2 },
  };
  const props = createChatProps({
    sessionKey: "agent:main:main",
    messages: [question],
    onAsyncQuestionSubmit: vi.fn(async () => true),
  });
  const draw = () => render(renderChat(props), container);
  const summary = () => container.querySelector(".chat-question-summary")?.textContent;
  draw();
  expect(summary()).toContain("Answer above");
  props.messages = [question, answer];
  draw();
  expect(summary()).toContain("Everyone");
  expect(summary()).not.toContain("Answer above");
  props.messages = [question, { ...answer, content: "> Which audience?\n\nEngineers" }];
  draw();
  expect(summary()).toContain("Engineers");
  expect(summary()).not.toContain("Everyone");
  props.messages = [question];
  draw();
  expect(summary()).toContain("Answer above");
  expect(summary()).not.toContain("Engineers");
});

it.each(["discard", "consumed"] as const)(
  "invalidates admission across same-session panes only for confirmed explicit discard (%s)",
  async (outcome) => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const sessionKey = "agent:main:main";
    const question = {
      ...audience,
      runId: "question-run",
      __openclaw: { id: "audience-question", seq: 1 },
    };
    const row: ChatQueueItem = {
      id: "failed-answer",
      sendRunId: "answer-run",
      sendAttempts: 1,
      asyncQuestionItemId: "audience",
      text: "> Which audience?\n\nNew contributors",
      createdAt: 1,
      sendState: "failed",
      sendError: "Synthetic rejection",
    };
    const panes = ["first", "second"].map((paneId) => {
      const element = document.createElement("div");
      document.body.append(element);
      const host = makeChatHost({
        requestHandlers: {},
        settings: { gatewayUrl: "ws://question-discard.test" },
        sessionKey,
        currentSessionId: "question-delivery-session",
        chatMessages: [question],
        requestUpdate: () => {
          props.queue = host.chatQueue;
          props.messages = host.chatMessages;
          render(renderChat(props), element);
        },
      });
      const props = createChatProps({
        paneId,
        sessionKey,
        messages: host.chatMessages,
        onAsyncQuestionSubmit: vi.fn(async () => true),
        onQueueRemove: (id) => {
          removeQueuedMessage(host, id, { discard: true });
        },
        onRequestUpdate: () => host.requestUpdate?.(),
      });
      const stop = chatOutboxOwner(host).subscribe(host, (item) =>
        getTranscriptState(paneId).transcriptRenderContext.onAsyncQuestionDiscard?.(item),
      );
      return { element, host, props, stop };
    });
    const first = panes[0]!;
    try {
      expect(
        admitQueuedMessageForSession(
          first.host,
          captureChatOutboxAdmission(first.host, sessionKey),
          row,
        ),
      ).toBe(true);
      for (const { host } of panes) {
        host.chatMessages = [question, ...["question-run", "later-run"].map(terminal)];
        host.requestUpdate?.();
      }
      const discard = () =>
        first.element.querySelector<HTMLButtonElement>(".chat-send-status__discard")!;
      expect(discard()).not.toBeNull();
      const remove = vi.spyOn(storage, "removeItem").mockImplementation(() => {
        throw new DOMException("Synthetic storage rejection", "QuotaExceededError");
      });
      discard().click();
      expect(remove).toHaveBeenCalledOnce();
      for (const { element } of panes) {
        expect(element.querySelector(".agent-chat__question-dock")).toBeNull();
        expect(element.querySelector(".chat-question-summary")?.textContent).toContain(
          "Answer not sent",
        );
      }
      remove.mockRestore();
      if (outcome === "discard") {
        discard().click();
      } else if (outcome === "consumed") {
        applyChatPendingInputs(
          first.host,
          { items: [], total: 0 },
          {
            receipts: [{ runId: "answer-run", state: "consumed", consumedByEventId: "aggregate" }],
          },
        );
      } else {
        expect(chatOutboxOwner(first.host).remove(first.host, row.id)?.id).toBe(row.id);
      }
      for (const { element, host, props } of panes) {
        expect(host.chatQueue).toEqual([]);
        if (outcome === "discard") {
          await vi.waitFor(() =>
            expect(
              element.querySelector<HTMLTextAreaElement>(".chat-question-panel__other")?.value,
            ).toBe("New contributors"),
          );
          expect(element.querySelector(".chat-question-summary")?.textContent).not.toContain(
            "Awaiting delivery confirmation",
          );
        } else {
          expect(element.querySelector(".agent-chat__question-dock")).toBeNull();
          expect(element.querySelector(".chat-question-summary")?.textContent).toContain(
            "Awaiting delivery confirmation",
          );
        }
        expect(props.onAsyncQuestionSubmit).not.toHaveBeenCalled();
      }
      if (outcome === "consumed") {
        const answer = {
          role: "user",
          content: row.text,
          __openclaw: { id: "audience-answer", seq: 2, replyToId: "audience-question" },
        };
        for (const [index, { element, host }] of panes.entries()) {
          reduceChatSessionProjection(host, {
            type: "snapshotLoaded",
            messages: [question, answer],
          });
          host.requestUpdate?.();
          expect(element.querySelector(".agent-chat__question-dock")).toBeNull();
          expect(element.querySelector(".chat-question-summary")?.textContent).toContain(
            "Answer sent",
          );
          if (index === 0) {
            expect(
              panes[1]!.element.querySelector(".chat-question-summary")?.textContent,
            ).toContain("Awaiting delivery confirmation");
          }
        }
      }
    } finally {
      for (const { element, stop } of panes) {
        stop();
        render(null, element);
        element.remove();
      }
    }
  },
);

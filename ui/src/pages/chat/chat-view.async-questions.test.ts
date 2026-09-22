/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import {
  admitQueuedMessageForSession,
  removeQueuedMessage,
  removeQueuedMessageWithoutReleasing,
  subscribeChatOutboxProjection,
} from "./chat-queue.ts";
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
afterEach(() => {
  render(null, container);
  container.remove();
  resetChatViewState();
  resetTranscriptTestDom();
  vi.unstubAllGlobals();
});

it("submits the docked answer after editing its draft without unrelated chat updates", async () => {
  installTranscriptDomMocks();
  document.body.append(container);
  const submit = vi.fn(async () => true);
  const props = createChatProps({
    sessionKey: "agent:main:main",
    messages: [
      {
        role: "assistant",
        content: "Which audience?",
        openclawAsyncDelivery: {
          itemId: "audience",
          questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
        },
      },
    ],
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
  await Promise.resolve();
  container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
  await vi.waitFor(() =>
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      "> Which audience?\n\nNew contributors",
      "audience",
      undefined,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector(".agent-chat__question-dock")).toBeNull());
  expect(container.querySelector(".chat-question-summary")?.textContent).toContain(
    "New contributors",
  );
});

it("selects a reopened historical question ahead of another pending request", async () => {
  installTranscriptDomMocks();
  document.body.append(container);
  const old = {
    role: "assistant",
    runId: "old-run",
    content: "Which audience?",
    openclawAsyncDelivery: {
      itemId: "audience",
      questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
    },
  };
  const latest = {
    role: "assistant",
    runId: "latest-run",
    content: "Which format?",
    openclawAsyncDelivery: {
      itemId: "format",
      questions: [{ title: "Which format?", options: ["Short", "Detailed"] }],
    },
  };
  const final = (runId: string) => ({
    role: "assistant",
    runId,
    content: "Finished.",
    phase: "final_answer",
    __openclaw: { runTerminal: true },
  });
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
  props.messages = [old, final("old-run"), latest, final("latest-run")];
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
  installTranscriptDomMocks();
  document.body.append(container);
  const question = {
    role: "assistant",
    content: "Which audience?",
    __openclaw: { id: "audience-question", seq: 1 },
    openclawAsyncDelivery: {
      itemId: "audience",
      questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
    },
  };
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

it.each(["discard", "ack", "consumed"] as const)(
  "invalidates admission across same-session panes only for confirmed explicit discard (%s)",
  async (outcome) => {
    installTranscriptDomMocks();
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const sessionKey = "agent:main:main";
    const question = {
      role: "assistant",
      runId: "question-run",
      content: "Which audience?",
      __openclaw: { id: "audience-question", seq: 1 },
      openclawAsyncDelivery: {
        itemId: "audience",
        questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
      },
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
      const stop = subscribeChatOutboxProjection(host, (item) =>
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
        host.chatMessages = [
          question,
          ...["question-run", "later-run"].map((runId) => ({
            role: "assistant",
            runId,
            content: "Finished.",
            phase: "final_answer",
            __openclaw: { runTerminal: true },
          })),
        ];
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
        expect(removeQueuedMessageWithoutReleasing(first.host, row.id)?.id).toBe(row.id);
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
it("keeps an edited answer visible when later work completes", async () => {
  installTranscriptDomMocks();
  document.body.append(container);
  const question = {
    role: "assistant",
    runId: "old-run",
    content: "Which audience?",
    openclawAsyncDelivery: {
      itemId: "audience",
      questions: [{ title: "Which audience?", options: ["Everyone"] }],
    },
  };
  const terminal = (runId: string) => ({
    role: "assistant",
    runId,
    content: "Done.",
    phase: "final_answer",
    __openclaw: { runTerminal: true },
  });
  const props = createChatProps({
    sessionKey: "agent:main:main",
    messages: [question],
    onAsyncQuestionSubmit: vi.fn(async () => true),
    onRequestUpdate: () => render(renderChat(props), container),
  });
  render(renderChat(props), container);
  await vi.waitFor(() =>
    expect(container.querySelector(".chat-question-panel__other")).not.toBeNull(),
  );
  const answer = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    ".chat-question-panel__other",
  )!;
  answer.value = "New contributors";
  answer.dispatchEvent(new Event("input", { bubbles: true }));
  props.messages = [question, terminal("old-run"), terminal("later-run")];
  render(renderChat(props), container);
  expect(container.querySelector(".agent-chat__question-dock")).not.toBeNull();
  expect(
    container.querySelector<HTMLInputElement | HTMLTextAreaElement>(".chat-question-panel__other")
      ?.value,
  ).toBe("New contributors");
});

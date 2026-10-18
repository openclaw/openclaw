/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../lib/presentation.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { subscribeChatOutboxQueue } from "./chat-outbox-queue.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { removeQueuedMessage } from "./chat-queue.ts";
import { createChatViewFrame } from "./chat-view-frame.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps, disposeChatView, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { getTranscriptState } from "./components/chat-thread-interactions.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";

let container: ReturnType<typeof createComposerContainer>;
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
  container = createComposerContainer();
  document.body.append(container);
});
afterEach(() => {
  disposeChatView(container);
  container.remove();
  resetChatViewState();
  resetTranscriptTestDom();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "keeps the edited docked answer current when later work completes=%s",
  async (laterWork) => {
    const pending = createDeferred<boolean>();
    const submit = vi.fn(() => pending.promise);
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
    });
    renderChatPropsInto(container, props);
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-question-panel__other")).not.toBeNull(),
    );
    const answer = container.querySelector<HTMLInputElement>(".chat-question-panel__other")!;
    answer.value = "New contributors";
    answer.dispatchEvent(new Event("input", { bubbles: true }));
    if (laterWork) {
      props.messages = [question, terminal("old-run"), terminal("later-run")];
      renderChatPropsInto(container, props);
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
    const owner = new EventTarget();
    let visible = false;
    props.transcriptVisible = { owner, isPresented: () => visible };
    renderChatPropsInto(container, props);
    pending.resolve(true);
    await waitForSolid(() =>
      expect(getTranscriptState(props.paneId).asyncQuestionDrafts.get("audience")?.status).toBe(
        "submitted",
      ),
    );
    flush();
    expect(container.querySelector(".agent-chat__question-dock")).not.toBeNull();
    visible = true;
    owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
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
  });
  const draw = () => renderChatPropsInto(container, props);
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

it("reads confirmed discard from the outbox before the next queue frame arrives", () => {
  const row: ChatQueueItem = {
    id: "discarded-answer",
    asyncQuestionItemId: "audience",
    text: "> Which audience?\n\nEngineers",
    createdAt: 1,
    sendState: "failed",
  };
  let queue = [row];
  const props = {
    ...createChatProps({
      messages: [
        { ...audience, runId: "question-run" },
        terminal("question-run"),
        terminal("later-run"),
      ],
      queue,
      onAsyncQuestionSubmit: vi.fn(async () => true),
    }),
    getQueue: () => queue,
  };
  const before = createChatViewFrame(props);
  expect(before.asyncQuestions.pending).toEqual([]);
  queue = [];
  before.asyncQuestions.discard(row);
  const after = createChatViewFrame(props);
  expect(after.asyncQuestions.pending.map((question) => question.itemId)).toEqual(["audience"]);
  expect(after.asyncQuestions.delivery.size).toBe(0);
  expect(props.onAsyncQuestionSubmit).not.toHaveBeenCalled();
});

it("refreshes a mounted question summary when a canonical answer appears or is replaced", async () => {
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
  const draw = () => renderChatPropsInto(container, props);
  const summary = () => container.querySelector(".chat-question-summary")?.textContent;
  draw();
  await waitForSolid(() => expect(summary()).toContain("Answer above"));
  props.messages = [question, answer];
  draw();
  await waitForSolid(() => {
    expect(summary()).toContain("Everyone");
    expect(summary()).not.toContain("Answer above");
  });
  props.messages = [question, { ...answer, content: "> Which audience?\n\nEngineers" }];
  draw();
  await waitForSolid(() => {
    expect(summary()).toContain("Engineers");
    expect(summary()).not.toContain("Everyone");
  });
  props.messages = [question];
  draw();
  await waitForSolid(() => {
    expect(summary()).toContain("Answer above");
    expect(summary()).not.toContain("Engineers");
  });
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
      const element = createComposerContainer();
      document.body.append(element);
      const host = makeChatHost({
        requestHandlers: {},
        settings: { gatewayUrl: "ws://question-discard.test" },
        sessionKey,
        currentSessionId: "question-delivery-session",
        chatMessages: [question],
      });
      const props = createChatProps({
        paneId,
        sessionKey,
        messages: host.chatMessages,
        onAsyncQuestionSubmit: vi.fn(async () => true),
        onQueueRemove: (id) => {
          removeQueuedMessage(host, id, { discard: true });
        },
      });
      const refresh = () => {
        props.queue = host.chatQueue;
        props.messages = host.chatMessages;
        renderChatPropsInto(element, props);
      };
      const stopPublication = subscribeChatOutboxQueue(host, refresh);
      const stop = chatOutboxOwner(host).subscribe(host, (item) =>
        getTranscriptState(paneId).transcriptRenderContext.onAsyncQuestionDiscard?.(item),
      );
      return {
        element,
        host,
        props,
        refresh,
        stop: () => {
          stopPublication();
          stop();
        },
      };
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
      for (const { host, refresh } of panes) {
        host.chatMessages = [question, ...["question-run", "later-run"].map(terminal)];
        refresh();
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
        for (const [index, { element, host, refresh }] of panes.entries()) {
          reduceChatSessionProjection(host, {
            type: "snapshotLoaded",
            messages: [question, answer],
          });
          refresh();
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
        disposeChatView(element);
        element.remove();
      }
    }
  },
);

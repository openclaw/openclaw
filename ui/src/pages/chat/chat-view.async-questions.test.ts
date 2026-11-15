/* @vitest-environment jsdom */

import { createRoot } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createChatProps, disposeChatView, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import type { ChatProps } from "./chat-view.tsx";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { getTranscriptState } from "./components/chat-thread-interactions.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";

let container: ReturnType<typeof createComposerContainer>;
const asyncQuestion = (itemId: string, title: string, options: string[]) => ({
  role: "assistant",
  content: title,
  openclawAsyncDelivery: { itemId, questions: [{ title, options }] },
});
const audience = asyncQuestion("audience", "Which audience?", ["Engineers", "Everyone"]);
const chatProps = (overrides: Partial<ChatProps>) =>
  createChatProps({
    sessionKey: "agent:main:main",
    onAsyncQuestionSubmit: vi.fn(async () => true),
    ...overrides,
  });
const other = (element = container) =>
  element.querySelector<HTMLInputElement | HTMLTextAreaElement>(".chat-question-panel__other");
const dock = (element = container) => element.querySelector(".agent-chat__question-dock");
const summaryText = (element = container) =>
  element.querySelector(".chat-question-summary")?.textContent;
const failedAnswer = (id: string, text: string): ChatQueueItem => ({
  id,
  asyncQuestionItemId: "audience",
  text: `> Which audience?\n\n${text}`,
  createdAt: 1,
  sendState: "failed",
});
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
          ...asyncQuestion("audience", "Which audience?", ["Everyone"]),
          runId: "old-run",
        }
      : audience;
    const props = chatProps({
      messages: [question],
      onAsyncQuestionSubmit: submit,
    });
    renderChatPropsInto(container, props);
    await vi.waitFor(() => expect(other()).not.toBeNull());
    const answer = other()!;
    answer.value = "New contributors";
    answer.dispatchEvent(new Event("input", { bubbles: true }));
    if (laterWork) {
      props.messages = [question, terminal("old-run"), terminal("later-run")];
      renderChatPropsInto(container, props);
      expect(dock()).not.toBeNull();
      expect(other()?.value).toBe("New contributors");
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
    expect(dock()).not.toBeNull();
    visible = true;
    owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    await vi.waitFor(() => expect(dock()).toBeNull());
    expect(summaryText()).toContain("New contributors");
  },
);

it("selects a reopened historical question ahead of another pending request", async () => {
  const old = { ...audience, runId: "old-run" };
  const latest = {
    ...asyncQuestion("format", "Which format?", ["Short", "Detailed"]),
    runId: "latest-run",
  };
  const props = chatProps({ messages: [old] });
  const draw = () => renderChatPropsInto(container, props);
  draw();
  await vi.waitFor(() => expect(other()).not.toBeNull());
  props.messages = [old, terminal("old-run"), latest, terminal("latest-run")];
  draw();
  await vi.waitFor(() => expect(dock()?.textContent).toContain("Which format?"));
  const summary = await waitForSolid(() => {
    const element = [...container.querySelectorAll<HTMLElement>(".chat-question-summary")].find(
      (candidate) => candidate.textContent?.includes("Which audience?"),
    );
    expect(element?.textContent).toContain("No longer pending");
    return element!;
  });
  summary.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(dock()?.textContent).toContain("Which audience?"));
  expect(other()?.value).toBe("");
});

it("reads confirmed discard from the outbox before the next queue frame arrives", () => {
  const row = failedAnswer("discarded-answer", "Engineers");
  let queue = [row];
  const props = {
    ...chatProps({
      sessionKey: "main",
      messages: [
        { ...audience, runId: "question-run" },
        terminal("question-run"),
        terminal("later-run"),
      ],
      queue,
    }),
    getQueue: () => queue,
  };
  const questions = createRoot((dispose) => {
    onTestFinished(dispose);
    return createComposerQuestions(props.paneId, () => props);
  });
  flush();
  const before = questions.source()!;
  expect(before.asyncQuestions.pending).toEqual([]);
  queue = [];
  before.asyncQuestions.discard(row);
  flush();
  const after = questions.source()!;
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
  const props = chatProps({ messages: [question] });
  for (const [text, previous] of [
    [null, null],
    ["Everyone", "Answer above"],
    ["Engineers", "Everyone"],
    [null, "Engineers"],
  ]) {
    props.messages = text
      ? [question, { ...answer, content: `> Which audience?\n\n${text}` }]
      : [question];
    renderChatPropsInto(container, props);
    await waitForSolid(() => {
      expect(summaryText()).toContain(text ?? "Answer above");
      if (previous) {
        expect(summaryText()).not.toContain(previous);
      }
    });
  }
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
      ...failedAnswer("failed-answer", "New contributors"),
      sendRunId: "answer-run",
      sendAttempts: 1,
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
      const props = chatProps({
        paneId,
        sessionKey,
        messages: host.chatMessages,
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
      await flushDeferredRowPrune();
      const discard = () =>
        first.element.querySelector<HTMLButtonElement>(".chat-send-status__discard")!;
      expect(discard()).not.toBeNull();
      const remove = vi.spyOn(storage, "removeItem").mockImplementation(() => {
        throw new DOMException("Synthetic storage rejection", "QuotaExceededError");
      });
      discard().click();
      expect(remove).toHaveBeenCalledOnce();
      for (const { element } of panes) {
        expect(dock(element)).toBeNull();
        expect(summaryText(element)).toContain("Answer not sent");
      }
      remove.mockRestore();
      if (outcome === "discard") {
        discard().click();
      } else {
        applyChatPendingInputs(
          first.host,
          { items: [], total: 0 },
          {
            receipts: [{ runId: "answer-run", state: "consumed", consumedByEventId: "aggregate" }],
          },
        );
      }
      for (const { element, host, props } of panes) {
        expect(host.chatQueue).toEqual([]);
        if (outcome === "discard") {
          await vi.waitFor(() => expect(other(element)?.value).toBe("New contributors"));
          expect(summaryText(element)).not.toContain("Awaiting delivery confirmation");
        } else {
          expect(dock(element)).toBeNull();
          expect(summaryText(element)).toContain("Awaiting delivery confirmation");
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
          expect(dock(element)).toBeNull();
          expect(summaryText(element)).toContain("Answer sent");
          if (index === 0) {
            expect(summaryText(panes[1]!.element)).toContain("Awaiting delivery confirmation");
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

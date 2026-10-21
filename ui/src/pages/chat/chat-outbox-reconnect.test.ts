/* @vitest-environment jsdom */
import { createComponent, createMemo, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems, idleChatHistory } from "./chat-outbox-recovery.test-support.ts";
import { keepVolatileQueuedMessage } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { createChatViewFrame } from "./chat-view-frame.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { ComposerQueue } from "./components/chat-composer-regions.tsx";
import { ChatThread } from "./components/chat-thread-view.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it("shows connected review waits without changing delivery versions or crossing the barrier", async () => {
  installTranscriptDomMocks();
  onTestFinished(() => {
    resetChatViewState();
    resetTranscriptTestDom();
  });
  const host = makeChatHost({
    connected: false,
    chatQueue: [
      {
        id: "a",
        text: "Attempted before disconnect",
        createdAt: 1,
        sendState: "waiting-reconnect",
        sendRunId: "run-a",
        sendAttempts: 1,
        sendRequestStartedAtMs: 1,
      },
      {
        id: "b",
        text: "> Which audience?\n\nEveryone",
        asyncQuestionItemId: "question-b",
        createdAt: 2,
        sendState: "waiting-reconnect",
        sendRunId: "run-b",
        sendAttempts: 0,
      },
    ],
    requestHandlers: { "chat.history": idleChatHistory() },
  });
  admitHostQueueItems(host);
  onTestFinished(chatOutboxOwner(host).subscribe(host));
  keepVolatileQueuedMessage(
    host,
    host.sessionKey,
    {
      id: "c",
      text: "Memory-only successor",
      createdAt: 3,
      sendState: "waiting-reconnect",
      sendRunId: "run-c",
      sendAttempts: 1,
      sendRequestStartedAtMs: 3,
    },
    undefined,
    { retryable: true },
  );
  const before = host.chatQueue;
  const container = document.createElement("div");
  document.body.append(container);
  const props = createChatProps({
    sessionKey: host.sessionKey,
    messages: [
      {
        role: "assistant",
        content: "Which audience?",
        phase: "final_answer",
        openclawAsyncDelivery: {
          itemId: "question-b",
          questions: [{ title: "Which audience?", options: ["Everyone"] }],
        },
      },
    ],
    onAsyncQuestionSubmit: vi.fn(async () => true),
    onQueueRetry: vi.fn(),
  });
  const currentProps = () => ({
    ...props,
    queue: host.chatQueue,
    connected: host.connected,
    offline: !host.connected,
  });
  const [viewProps, setViewProps] = createSignal(currentProps());
  const view = mountSolid(
    () => {
      const questions = createComposerQuestions(props.paneId, viewProps);
      const frame = createMemo(() =>
        createChatViewFrame(viewProps(), () => undefined, questions.source()!.asyncQuestions),
      );
      return [
        createComponent(ChatThread, {
          get props() {
            return frame().threadProps;
          },
          transcript: props.transcript,
        }),
        createComponent(ComposerQueue, {
          get composer() {
            return { ...viewProps(), displayQueue: frame().displayQueue };
          },
          showAbortableUi: false,
        }),
      ];
    },
    { container },
  );
  onTestFinished(() => {
    view.unmount();
    props.transcript.dispose();
    container.remove();
  });
  const draw = () => {
    setViewProps(currentProps());
    flush();
    props.transcript.start();
    props.transcript.update();
    flush();
  };

  await resumeStoredChatOutboxes(host);
  expect(host.chatQueue).toEqual(before);
  draw();
  expect(container.textContent).toContain("Waiting for reconnect");
  expect(container.querySelector(".chat-queue__badge")?.textContent).toContain(
    "Waiting for reconnect",
  );
  expect(container.querySelector(".chat-send-status")?.textContent).toContain(
    "Waiting for reconnect",
  );
  expect(container.querySelector(".chat-question-summary__delivery")?.textContent).toContain(
    "Waiting for reconnect",
  );

  host.connected = true;
  host.connectionEpoch += 1;
  await resumeStoredChatOutboxes(host);

  expect(host.chatQueue).toEqual([
    expect.objectContaining({ ...before[0], sendState: "unconfirmed" }),
    before[1],
    before[2],
  ]);
  expect(listStoredChatOutboxes(host)[0]?.queue.map((item) => [item.id, item.sendState])).toEqual([
    ["a", "unconfirmed"],
    ["b", "waiting-reconnect"],
  ]);
  expect(chatOutboxOwner(host).hasVolatile(host, "c")).toBe(true);
  draw();
  expect(container.textContent).not.toContain("Waiting for reconnect");
  const unconfirmed = container.querySelector('.chat-send-status[data-send-state="unconfirmed"]');
  expect(unconfirmed?.textContent).toContain("Delivery unconfirmed");
  expect(unconfirmed?.querySelector(".chat-send-status__retry")).not.toBeNull();
  expect(unconfirmed?.querySelector(".chat-send-status__discard")).not.toBeNull();
  const pending = container.querySelector('.chat-send-status[data-send-state="waiting-reconnect"]');
  expect(pending?.textContent).toContain("Queued");
  expect(pending?.querySelector(".chat-send-status__discard")).not.toBeNull();
  expect(pending?.querySelector(".chat-send-status__retry")).toBeNull();
  expect(container.querySelector(".chat-question-summary__delivery")?.textContent).toContain(
    "Answer queued",
  );
  expect(container.querySelector(".chat-queue__global-state")?.textContent?.trim()).toBe(
    "Queue paused. Retry or discard the earlier unconfirmed message in the conversation.",
  );
  expect(requestCalls(host.request, "chat.send")).toEqual([]);

  // Connection-only updates must invalidate cached transcript/question labels.
  host.connected = false;
  draw();
  expect(
    container.querySelector(".chat-send-status[data-send-state='waiting-reconnect']"),
  ).not.toBeNull();
  expect(container.querySelector(".chat-question-summary__delivery")?.textContent).toContain(
    "Waiting for reconnect",
  );
  host.connected = true;
  draw();
  expect(container.textContent).not.toContain("Waiting for reconnect");
});

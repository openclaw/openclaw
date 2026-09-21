/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const container = document.createElement("div");
afterEach(() => {
  render(null, container);
  container.remove();
  resetChatViewState();
  resetTranscriptTestDom();
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
    expect(submit).toHaveBeenCalledExactlyOnceWith("> Which audience?\n\nNew contributors"),
  );
  await vi.waitFor(() => expect(container.querySelector(".agent-chat__question-dock")).toBeNull());
  expect(container.querySelector(".chat-question-summary")?.textContent).toContain(
    "New contributors",
  );
});

it("selects a reopened historical question ahead of another pending request without losing its draft", async () => {
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
  const draft = container.querySelector<HTMLInputElement>(".chat-question-panel__other")!;
  draft.value = "New contributors";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
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
  expect(container.querySelector<HTMLInputElement>(".chat-question-panel__other")?.value).toBe(
    "New contributors",
  );
});

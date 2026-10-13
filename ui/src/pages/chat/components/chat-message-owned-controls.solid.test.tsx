/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { buildLocalUserMessage } from "../user-message-content.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { dismissConfirmedActionPopovers } from "./chat-message-confirmation-view.tsx";
import { MessageGroup } from "./chat-message-group-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";

beforeEach(() => localStorage.removeItem("openclaw:skip-rewind-confirm"));
afterEach(() => dismissConfirmedActionPopovers(document.body));

it("keeps an open work-context disclosure when the same message key receives fresh metadata", () => {
  const message = (title: string) =>
    buildLocalUserMessage({
      text: "Explain this selection",
      createdAt: 1000,
      workContext: { title, page: "chat" },
    });
  const [source, setSource] = createSignal(message("Before"));
  const view = mountSolid(() => (
    <GroupedMessage
      preparation={prepareChatMessageRender(source())}
      messageKey="same-message"
      options={{ isStreaming: false, showReasoning: false }}
    />
  ));
  const disclosure = view.container.querySelector<HTMLDetailsElement>(".chat-context-attachment")!;
  expect(disclosure).not.toBeNull();
  disclosure.open = true;
  setSource(message("After"));
  flush();
  expect(view.container.querySelector(".chat-context-attachment")).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(disclosure.textContent).toContain("After");
});

it("retains grouped rewind and timestamp controls with current callbacks and metadata", () => {
  const previous = vi.fn();
  const current = vi.fn();
  const prompt = createMessageGroup({ role: "user", content: "Prompt", timestamp: 1000 }, "user");
  const answer = createMessageGroup(
    { role: "assistant", content: "Answer", timestamp: 1001, usage: { input: 100, output: 10 } },
    "assistant",
  );
  const [options, setOptions] = createSignal({ onRewind: previous, contextWindow: 4000 });
  const [assistant, setAssistant] = createSignal(answer);
  const view = mountSolid(() => (
    <>
      <MessageGroup group={prompt} options={{ showReasoning: false, ...options() }} />
      <MessageGroup
        group={assistant()}
        options={{ showReasoning: false, contextWindow: options().contextWindow }}
      />
    </>
  ));
  const trigger = view.getByRole("button", { name: "Rewind" });
  trigger.click();
  const confirmation = document.querySelector<HTMLElement>(".chat-confirm-popover")!;
  expect(confirmation).not.toBeNull();
  setOptions({ onRewind: current, contextWindow: 8000 });
  flush();
  expect(view.getByRole("button", { name: "Rewind" })).toBe(trigger);
  expect(document.querySelector(".chat-confirm-popover")).toBe(confirmation);
  confirmation.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes")!.click();
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledOnce();

  const timestamp = view.container.querySelector<HTMLButtonElement>(
    ".chat-group.assistant .msg-meta__summary",
  )!;
  expect(timestamp).not.toBeNull();
  timestamp.focus();
  setAssistant({
    ...answer,
    timestamp: 2001,
    messages: [
      {
        ...answer.messages[0]!,
        message: {
          role: "assistant",
          content: "Answer",
          timestamp: 2001,
          usage: { input: 200, output: 20 },
        },
      },
    ],
  });
  flush();
  expect(view.container.querySelector(".chat-group.assistant .msg-meta__summary")).toBe(timestamp);
  expect(document.activeElement).toBe(timestamp);
});

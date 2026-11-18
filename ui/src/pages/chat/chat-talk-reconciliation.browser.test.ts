import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import "../../styles/chat.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { createChatProps, disposeChatView, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { createChatTranscript } from "./components/chat-transcript-controller.ts";

let fixture: HTMLElement | undefined;
afterEach(() => {
  if (fixture) {
    disposeChatView(fixture);
    fixture.remove();
    fixture = undefined;
  }
});
it("reconciles persisted voice while preserving the live tail", async () => {
  await page.viewport(1440, 900);
  fixture = createComposerContainer();
  fixture.style.cssText = "display:block;height:900px;width:100%";
  document.body.append(fixture);
  const transcript = createChatTranscript(() => "talk-reconciliation", {
    canFollowEnd: () => true,
  });
  const props = createChatProps({
    transcript,
    paneId: "talk-reconciliation",
    assistantName: "Assistant",
    realtimeTalkActive: true,
    messages: [],
    readRealtimeTalkConversation: () => [
      {
        id: "rt-1",
        role: "user",
        text: "Tell me about otters.",
        isStreaming: false,
        transcriptId: "voice:call:1",
      },
      {
        id: "rt-2",
        role: "assistant",
        text: "Otters use rocks to open shellfish.",
        isStreaming: false,
        transcriptId: "voice:call:2",
      },
      { id: "rt-3", role: "user", text: "Now check the room temperature.", isStreaming: true },
    ],
  });
  renderChatPropsInto(fixture, props);
  await expect.poll(() => fixture!.querySelectorAll(".agent-chat__voice-turn").length).toBe(3);
  props.messages = [
    {
      role: "user",
      content: "Tell me about otters.",
      __openclaw: { id: "voice:call:1" },
    },
    {
      role: "assistant",
      content: "Otters use rocks to open shellfish.",
      __openclaw: { id: "voice:call:2" },
    },
  ];
  renderChatPropsInto(fixture, props);
  // Inspect the mounted history as well as the live tail after reconciliation.
  transcript.scrollToEnd();
  await expect.poll(() => fixture!.querySelectorAll(".chat-text").length).toBe(2);
  expect(fixture.querySelectorAll(".agent-chat__voice-turn")).toHaveLength(1);
  const renderedMessages = [...fixture.querySelectorAll(".chat-text")]
    .map((element) => element.textContent)
    .join("\n");
  expect(renderedMessages.match(/Tell me about otters\./g)).toHaveLength(1);
  expect(renderedMessages.match(/Otters use rocks to open shellfish\./g)).toHaveLength(1);
  expect(fixture.querySelector(".agent-chat__voice-turn")?.textContent).toContain(
    "Now check the room temperature.",
  );
});

it("keeps an unsaved voice caption above messages typed after it", async () => {
  await page.viewport(1440, 900);
  fixture = createComposerContainer();
  fixture.style.cssText = "display:block;height:900px;width:100%";
  document.body.append(fixture);
  const typedExchange = [
    { role: "user", content: "Typed question.", __openclaw: { id: "m-1", runId: "run-1" } },
    { role: "assistant", content: "Typed answer.", __openclaw: { id: "m-2", runId: "run-1" } },
  ];
  const props = createChatProps({
    transcript: createChatTranscript(() => "talk-chronology", { canFollowEnd: () => true }),
    paneId: "talk-chronology",
    assistantName: "Assistant",
    realtimeTalkActive: true,
    messages: typedExchange,
    // The spoken question never received a saved history row.
    readRealtimeTalkConversation: () => [
      {
        id: "rt-1",
        role: "user",
        text: "Spoken question.",
        isStreaming: false,
        afterMessageId: "m-2",
      },
    ],
  });
  renderChatPropsInto(fixture, props);
  await expect.poll(() => fixture!.querySelectorAll(".agent-chat__voice-turn").length).toBe(1);
  props.messages = [
    ...typedExchange,
    { role: "assistant", content: "Spoken answer.", __openclaw: { id: "voice:call:2" } },
    { role: "user", content: "Typed follow-up.", __openclaw: { id: "m-3", runId: "run-2" } },
  ];
  renderChatPropsInto(fixture, props);
  const order = () =>
    [...fixture!.querySelectorAll(".chat-text, .agent-chat__voice-turn-text")].map((element) =>
      element.textContent?.trim(),
    );
  await expect.poll(() => order().length).toBe(5);
  expect(order()).toEqual([
    "Typed question.",
    "Typed answer.",
    "Spoken question.",
    "Spoken answer.",
    "Typed follow-up.",
  ]);
});

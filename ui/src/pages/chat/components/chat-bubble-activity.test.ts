/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("keeps streaming text and open status details stable behind the dot preview", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const transcript = createTestTranscript();
  const props = {
    ...threadProps("bubble-stream", "agent:main:main", [
      { role: "user", content: "Check this", timestamp: 1 },
    ]),
    chatBubbleMode: true,
    runActive: true,
    runWorking: true,
    runId: "bubble-run",
    stream: "Here is the first part",
    streamStartedAt: 2,
  };
  const draw = () => render(renderChatThread(props, transcript), container);
  draw();
  const paragraph = container.querySelector(".chat-bubble.streaming p");
  expect(paragraph?.textContent).toBe("Here is the first part");
  const details = container.querySelector<HTMLDetailsElement>(".chat-bubble-activity");
  expect(details).not.toBeNull();
  expect(details?.open).toBe(false);
  expect(details?.querySelectorAll(".chat-bubble-dots > span")).toHaveLength(3);
  details!.querySelector("summary")!.click();
  expect(details?.open).toBe(true);
  expect(details?.querySelector(".chat-working-indicator")).not.toBeNull();
  props.stream += " and the rest of the answer.";
  draw();
  expect(container.querySelector(".chat-bubble.streaming p")).toBe(paragraph);
  expect(paragraph?.textContent).toContain("the rest of the answer.");
  expect(container.querySelector(".chat-bubble-activity")).toBe(details);
  expect(details?.open).toBe(true);
  props.chatBubbleMode = false;
  draw();
  expect(container.querySelector(".chat-bubble-activity")).toBeNull();
  expect(container.querySelector(".chat-working-indicator")).not.toBeNull();
  transcript.hostDisconnected();
});

it("hides tool previews until the dots are clicked, without hiding the answer", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const transcript = createTestTranscript();
  const props = {
    ...threadProps("bubble-tools", "agent:main:main", [
      { role: "user", content: "Check this", timestamp: 1 },
    ]),
    chatBubbleMode: true,
    showToolCalls: true,
    runActive: true,
    runWorking: true,
    runId: "bubble-run",
    stream: "The answer keeps streaming.",
    streamStartedAt: 2,
    toolMessages: [
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "bubble-read",
        runId: "bubble-run",
        content: "Detailed file contents.",
        timestamp: 3,
      },
    ],
  };
  const draw = () =>
    render(renderChatThread({ ...props, onRequestUpdate: draw }, transcript), container);
  draw();
  const button = container.querySelector<HTMLButtonElement>(
    ".chat-activity-group--bubble > button",
  );
  expect(button?.getAttribute("aria-label")).toBe("View activity details");
  expect(button?.textContent?.trim()).toBe("");
  expect(container.textContent).not.toContain("Detailed file contents.");
  expect(container.textContent).toContain("The answer keeps streaming.");
  const status = container.querySelector<HTMLDetailsElement>(".chat-bubble-activity");
  expect(status).not.toBeNull();
  status!.querySelector("summary")!.click();
  expect(status!.open).toBe(true);
  expect(status!.querySelector(".chat-working-indicator")).not.toBeNull();
  button!.click();
  expect(container.querySelector(".chat-activity-group.is-open")).not.toBeNull();
  const tool = container.querySelector<HTMLButtonElement>(
    ".chat-activity-group__body .chat-tool-msg-summary",
  );
  expect(tool).not.toBeNull();
  tool!.click();
  expect(container.textContent).toContain("Detailed file contents.");
  expect(container.textContent).toContain("The answer keeps streaming.");
  transcript.hostDisconnected();
});

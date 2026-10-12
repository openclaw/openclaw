/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("keeps streaming text and open status details stable behind the dot preview", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const transcript = createTestTranscript();
  let connected = false;
  onTestFinished(() => {
    render(nothing, container);
    transcript.hostDisconnected();
    container.remove();
  });
  const props: ChatThreadProps = {
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
  const draw = () => {
    render(renderChatThread(props, transcript), container);
    if (!connected) {
      transcript.hostConnected();
      connected = true;
    }
    transcript.hostUpdated();
  };
  draw();
  await waitForSolid(() => {
    expect(container.querySelector(".chat-bubble.streaming p")?.textContent).toBe(
      "Here is the first part",
    );
    expect(container.querySelector(".chat-bubble-activity")).not.toBeNull();
  });
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
  await waitForSolid(() => {
    expect(container.querySelector(".chat-bubble.streaming p")).toBe(paragraph);
    expect(paragraph?.textContent).toContain("the rest of the answer.");
    expect(container.querySelector(".chat-bubble-activity")).toBe(details);
    expect(details?.open).toBe(true);
  });
  props.chatBubbleMode = false;
  draw();
  await waitForSolid(() => {
    expect(container.querySelector(".chat-bubble-activity")).toBeNull();
    expect(container.querySelector(".chat-working-indicator")).not.toBeNull();
  });
});

it("labels tool activity and exposes existing cards without hiding the answer", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const transcript = createTestTranscript();
  let connected = false;
  onTestFinished(() => {
    render(nothing, container);
    transcript.hostDisconnected();
    container.remove();
  });
  const props: ChatThreadProps = {
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
  const draw = () => {
    render(renderChatThread({ ...props, onRequestUpdate: draw }, transcript), container);
    if (!connected) {
      transcript.hostConnected();
      connected = true;
    }
    transcript.hostUpdated();
  };
  draw();
  await waitForSolid(() => {
    expect(container.querySelector(".chat-activity-group--bubble > button")?.textContent).toContain(
      "Raw details",
    );
    expect(container.textContent).toContain("The answer keeps streaming.");
  });
  const button = container.querySelector<HTMLButtonElement>(
    ".chat-activity-group--bubble > button",
  );
  expect(button?.textContent).toContain("Raw details");
  expect(button?.querySelector(".chat-bubble-dots")).toBeNull();
  expect(container.textContent).not.toContain("Detailed file contents.");
  expect(container.textContent).toContain("The answer keeps streaming.");
  const status = container.querySelector<HTMLDetailsElement>(".chat-bubble-activity");
  expect(status).not.toBeNull();
  status!.querySelector("summary")!.click();
  expect(status!.open).toBe(true);
  expect(status!.querySelector(".chat-working-indicator")).not.toBeNull();
  button!.click();
  await waitForSolid(() =>
    expect(container.querySelector(".chat-activity-group.is-open")).not.toBeNull(),
  );
  const tool = container.querySelector<HTMLButtonElement>(
    ".chat-activity-group__body .chat-tool-msg-summary",
  );
  expect(tool).not.toBeNull();
  tool!.click();
  await waitForSolid(() => {
    expect(container.textContent).toContain("Detailed file contents.");
    expect(container.textContent).toContain("The answer keeps streaming.");
  });
  props.runActive = false;
  props.runWorking = false;
  props.stream = null;
  props.runId = null;
  props.streamStartedAt = null;
  draw();
  await waitForSolid(() => {
    expect(container.querySelector(".chat-bubble-dots--working")).toBeNull();
    expect(container.textContent).toContain("Detailed file contents.");
  });
});

it.each([
  { label: "Starting model", options: { startupLabel: "Starting model" } },
  { label: "Waiting for approval", options: { waitingApproval: true } },
])("keeps $label visible instead of replacing it with working dots", ({ label, options }) => {
  const container = document.createElement("div");
  render(
    renderChatWorkingIndicator(
      { kind: "reading-indicator", key: "status", startedAt: 1 },
      { bubbleMode: true, ...options },
    ),
    container,
  );
  expect(container.querySelector("details")).toBeNull();
  expect(container.querySelector(".chat-working-indicator")?.textContent).toContain(label);
  expect(container.querySelector(".chat-bubble-dots--working")).toBeNull();
  render(nothing, container);
});

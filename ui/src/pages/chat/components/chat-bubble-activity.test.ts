/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import { createToolResultMessage } from "./chat-message.test-support.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";
import { ChatWorkingIndicator } from "./chat-working-indicator.tsx";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function mountThread(id: string, overrides: Partial<ChatThreadProps> = {}) {
  const container = document.body.appendChild(document.createElement("div"));
  const transcript = createTestTranscript();
  onTestFinished(() => {
    render(null, container);
    transcript.dispose();
    container.remove();
  });
  const props: ChatThreadProps = {
    ...threadProps(id, "agent:main:main", [{ role: "user", content: "Check this", timestamp: 1 }]),
    chatBubbleMode: true,
    runActive: true,
    runWorking: true,
    runId: "bubble-run",
    stream: "Here is the first part",
    streamStartedAt: 2,
    ...overrides,
  };
  const draw = () => {
    render(renderChatThread(props, transcript), container);
    transcript.update();
  };
  render(renderChatThread(props, transcript), container);
  transcript.start();
  transcript.update();
  const find = (selector: string) => container.querySelector(selector);
  return { container, props, draw, find };
}

it("keeps streaming text and open status details stable behind the dot preview", async () => {
  const { container, props, draw, find } = mountThread("bubble-stream");
  await waitForSolid(() => {
    expect(find(".chat-bubble.streaming p")?.textContent).toBe("Here is the first part");
    expect(find(".chat-bubble-activity")).not.toBeNull();
  });
  const paragraph = find(".chat-bubble.streaming p");
  const details = container.querySelector<HTMLDetailsElement>(".chat-bubble-activity");
  expect(details?.open).toBe(false);
  expect(details?.querySelectorAll(".chat-bubble-dots > span")).toHaveLength(3);
  details!.querySelector("summary")!.click();
  expect(details?.open).toBe(true);
  expect(details?.querySelector(".chat-working-indicator")).not.toBeNull();
  props.stream += " and the rest of the answer.";
  draw();
  await waitForSolid(() => {
    expect(find(".chat-bubble.streaming p")).toBe(paragraph);
    expect(paragraph?.textContent).toContain("the rest of the answer.");
    expect(find(".chat-bubble-activity")).toBe(details);
    expect(details?.open).toBe(true);
  });
  props.chatBubbleMode = false;
  draw();
  await waitForSolid(() => {
    expect(find(".chat-bubble-activity")).toBeNull();
    expect(find(".chat-working-indicator")).not.toBeNull();
  });
});

it("labels tool activity and exposes existing cards without hiding the answer", async () => {
  const { container, props, draw, find } = mountThread("bubble-tools", {
    showToolCalls: true,
    stream: "The answer keeps streaming.",
    toolMessages: [
      createToolResultMessage("bubble-read", "read", "Detailed file contents.", {
        runId: "bubble-run",
        timestamp: 3,
      }),
    ],
  });
  await waitForSolid(() => {
    expect(find(".chat-activity-group--bubble > button")?.textContent).toContain("Raw details");
    expect(container.textContent).toContain("The answer keeps streaming.");
  });
  const button = container.querySelector<HTMLButtonElement>(
    ".chat-activity-group--bubble > button",
  );
  expect(button?.querySelector(".chat-bubble-dots")).toBeNull();
  expect(container.textContent).not.toContain("Detailed file contents.");
  const status = container.querySelector<HTMLDetailsElement>(".chat-bubble-activity");
  expect(status).not.toBeNull();
  status!.querySelector("summary")!.click();
  expect(status!.open).toBe(true);
  expect(status!.querySelector(".chat-working-indicator")).not.toBeNull();
  button!.click();
  await waitForSolid(() => {
    expect(find(".chat-activity-group.is-open")).not.toBeNull();
    expect(find(".chat-activity-group__body .chat-tool-msg-summary:enabled")).not.toBeNull();
  });
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
    expect(find(".chat-bubble-dots--working")).toBeNull();
    expect(container.textContent).toContain("Detailed file contents.");
  });
});

it("keeps model startup quiet and approval actionable in bubble mode", () => {
  const { container, dispose } = mountSolid(ChatWorkingIndicator, {
    part: { kind: "reading-indicator", key: "status", startedAt: 1 },
    options: { bubbleMode: true, startupLabel: "Starting model", outputTokens: 42 },
  });
  onTestFinished(dispose);
  const summary = container.querySelector("summary")!;
  expect(summary.textContent?.trim()).toBe("");
  expect(summary.querySelectorAll(".chat-bubble-dots > span")).toHaveLength(3);
  expect(container.querySelector("openclaw-working-phrase")).toBeNull();
  summary.click();
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.textContent).toContain("Starting model");
  const approval = mountSolid(ChatWorkingIndicator, {
    part: { kind: "reading-indicator", key: "approval", startedAt: 1 },
    options: { bubbleMode: true, waitingApproval: true },
  });
  onTestFinished(approval.dispose);
  expect(approval.container.querySelector("summary")?.textContent).toContain(
    "Waiting for approval",
  );
  expect(approval.container.querySelector("summary .chat-bubble-dots")).toBeNull();
  expect(approval.container.querySelector("svg")).toBeNull();
});

it("uses one live work bubble and restores dots when the operation settles", async () => {
  const call = (phase: "start" | "result") => ({
    role: "assistant",
    runId: "bubble-run",
    timestamp: 3,
    content: [
      {
        type: "toolcall",
        id: "check",
        name: "exec",
        arguments: { command: "pnpm test", title: "Checking the tests" },
      },
    ],
    activity: [
      projectAgentToolActivity({
        toolCallId: "check",
        name: "exec",
        args: { command: "pnpm test", title: "Checking the tests" },
        phase,
      }),
    ],
  });
  const { container, props, draw } = mountThread("bubble-live-work", {
    showToolCalls: true,
    toolMessages: [call("start")],
  });
  await waitForSolid(() => {
    const summary = container.querySelector(".chat-activity-group--working > button");
    expect(summary?.textContent).toContain("Checking the tests");
    expect(summary?.querySelectorAll(".chat-bubble-dots > span")).toHaveLength(3);
    expect(container.querySelector("details.chat-bubble-activity--working")).toBeNull();
  });
  props.toolMessages = [call("result")];
  draw();
  await waitForSolid(() => {
    expect(container.querySelector(".chat-activity-group--working")).toBeNull();
    expect(container.querySelectorAll("summary .chat-bubble-dots--working")).toHaveLength(1);
  });
});

it("collapses parallel work behind one bubble without hiding task links", async () => {
  const sessions = ["first", "second"].map((id) => ({
    key: "agent:main:subagent:" + id,
    kind: "direct" as const,
    updatedAt: 1,
  }));
  const { container, dispose } = mountSolid(ChatWorkingIndicator, {
    part: { kind: "reading-indicator", key: "parallel", startedAt: 1 },
    options: {
      bubbleMode: true,
      runningSubagents: 2,
      subagentActivity: {
        rows: sessions.map((session) => ({
          session,
          key: session.key,
          label: session.key.endsWith("first") ? "Checking tests" : "Reviewing the fix",
          status: "running" as const,
          listed: true,
        })),
        onOpenSubagent: () => {},
      },
    },
  });
  onTestFinished(dispose);
  await waitForSolid(() =>
    expect(container.querySelectorAll("[data-subagent-session-key]")).toHaveLength(2),
  );
  expect(container.querySelector("summary")?.textContent).toContain("2 tasks");
  expect(container.querySelectorAll("summary .chat-bubble-dots--working")).toHaveLength(1);
  expect(container.querySelector("summary svg")).toBeNull();
  container.querySelector("summary")!.click();
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelectorAll("[data-subagent-session-key] button")).toHaveLength(2);
});

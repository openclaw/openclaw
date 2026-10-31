/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawCanvasWidgetView } from "../../../components/canvas-widget-view.tsx";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createInitializationContext } from "../chat-application-context.test-support.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import { agentEvent, createHost, useToolStreamFakeTimers } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
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
  const container = document.body.appendChild(
    overrides.applicationContext
      ? createApplicationContextProvider(overrides.applicationContext)
      : document.createElement("div"),
  );
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

it("switches between bubble disclosure and inline work without losing the status", () => {
  const options = { bubbleMode: true, startupLabel: "Starting model", outputTokens: 42 };
  const part = { kind: "reading-indicator" as const, key: "status", startedAt: 1 };
  const view = mountSolid(ChatWorkingIndicator, {
    part,
    options,
  });
  onTestFinished(view.dispose);
  const query = (selector: string) => view.container.querySelector(selector);
  expect(query("details.chat-bubble-activity")).not.toBeNull();
  view.update({ part, options: { ...options, bubbleMode: false } });
  expect(query(".chat-bubble-activity")).toBeNull();
  expect(query(".chat-working-indicator")?.textContent).toContain("Starting model");
});

it("keeps approval actionable instead of quiet bubble dots", () => {
  const { container, dispose } = mountSolid(ChatWorkingIndicator, {
    part: { kind: "reading-indicator", key: "approval", startedAt: 1 },
    options: { bubbleMode: true, waitingApproval: true },
  });
  onTestFinished(dispose);
  expect(container.querySelector("summary")?.textContent).toContain("Waiting for approval");
  expect(container.querySelector("summary .chat-bubble-dots")).toBeNull();
  expect(container.querySelector("svg")).toBeNull();
});

it("renders unfinished widget input through the transcript with tool details hidden", async () => {
  const applicationContext = createInitializationContext();
  const host = createHost({ chatRunId: "bubble-run" });
  const receive = (seq: number, data: Record<string, unknown>) => {
    useToolStreamFakeTimers();
    handleAgentEvent(
      host,
      agentEvent("bubble-run", seq, "tool", {
        name: "show_widget",
        toolCallId: "survey",
        ...data,
      }),
    );
    vi.advanceTimersByTime(100);
    vi.useRealTimers();
  };
  const first = { title: "Survey", html: "<h2>Survey</h2>" };
  receive(1, { phase: "widget_preview", preview: first });
  const { container, props, draw, find } = mountThread("widget-input", {
    sessionKey: "main",
    applicationContext,
    stream: null,
    showToolCalls: false,
    toolMessages: host.chatToolMessages,
  });
  const widget = () =>
    container.querySelector<OpenClawCanvasWidgetView>("openclaw-canvas-widget-view");
  await waitForSolid(() => expect(widget()?.inputPreview).toEqual(first));
  const original = widget();
  const next = { title: "Survey", html: "<h2>Survey</h2><p>24 sites</p>" };
  receive(2, { phase: "widget_preview", preview: next });
  props.toolMessages = host.chatToolMessages;
  draw();
  await waitForSolid(() => expect(widget()?.inputPreview).toEqual(next));
  expect(widget()).toBe(original);
  expect(find("[data-widget-actions]")).toBeNull();
  props.mediaReadAllowed = false;
  draw();
  await waitForSolid(() => expect(widget()).toBeNull());
  expect(find('[data-content-kind="widget-input"]')).not.toBeNull();
  props.mediaReadAllowed = true;
  receive(3, {
    phase: "result",
    isError: true,
    result: { content: [{ type: "text", text: "Invalid script" }] },
  });
  props.toolMessages = host.chatToolMessages;
  draw();
  await waitForSolid(() => expect(find('[data-content-kind="widget-input"]')).toBeNull());
});

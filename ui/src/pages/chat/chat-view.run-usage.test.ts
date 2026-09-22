/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatInto } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

it("keeps multi-part run usage current when only output tokens change", () => {
  const runId = "run-composed";
  const user = {
    kind: "group",
    key: "group:user:run-composed",
    role: "user",
    visibleContent: "text",
    messages: [
      {
        key: "message:user:run-composed",
        message: {
          role: "user",
          content: "Start the work.",
          timestamp: 0,
          __openclaw: { id: "user:run-composed", idempotencyKey: `${runId}:user` },
        },
      },
    ],
    timestamp: 0,
    isStreaming: false,
  };
  const assistant = {
    kind: "group",
    key: "group:assistant:run-start",
    role: "assistant",
    visibleContent: "text",
    messages: [
      {
        key: "message:assistant:run-start",
        message: { role: "assistant", content: "Starting the work.", timestamp: 1 },
      },
    ],
    timestamp: 1,
    isStreaming: false,
    runId,
  };
  const tool = {
    kind: "group",
    key: "group:tool:run-work",
    role: "tool",
    visibleContent: "text",
    messages: [
      {
        key: "message:tool:run-work",
        message: { role: "toolResult", content: "Tool complete.", timestamp: 2 },
      },
    ],
    timestamp: 2,
    isStreaming: false,
    runId,
  };
  const reading = {
    kind: "reading-indicator",
    key: "reading:run-composed",
    startedAt: 1,
    runId,
  };
  vi.spyOn(chatThread, "buildCachedChatItems").mockReturnValue([
    user,
    assistant,
    tool,
    reading,
  ] as ReturnType<typeof chatThread.buildCachedChatItems>);
  const container = document.createElement("div");

  renderChatInto(container, {
    canAbort: true,
    runId,
    runUsageById: new Map([[runId, { outputTokens: 5_500, seq: 1 }]]),
    stream: null,
  });
  expect(container.querySelector(".chat-working-indicator__tokens")?.textContent).toContain("5.5k");
  renderChatInto(container, {
    canAbort: true,
    runId,
    runUsageById: new Map([[runId, { outputTokens: 7_200, seq: 2 }]]),
    stream: null,
  });

  expect(container.querySelector(".chat-working-indicator__tokens")?.textContent).toContain("7.2k");
});

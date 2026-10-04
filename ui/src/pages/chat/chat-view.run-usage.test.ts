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
  const group = (id: string, role: string, timestamp: number, message: unknown) => ({
    kind: "group",
    key: `group:${id}`,
    role,
    visibleContent: "text",
    messages: [{ key: `message:${id}`, message }],
    timestamp,
    isStreaming: false,
    ...(role === "user" ? {} : { runId }),
  });
  const user = group("user:run-composed", "user", 0, {
    role: "user",
    content: "Start the work.",
    timestamp: 0,
    __openclaw: { id: "user:run-composed", idempotencyKey: `${runId}:user` },
  });
  const assistant = group("assistant:run-start", "assistant", 1, {
    role: "assistant",
    content: "Starting the work.",
    timestamp: 1,
  });
  const tool = group("tool:run-work", "tool", 2, {
    role: "toolResult",
    content: "Tool complete.",
    timestamp: 2,
  });
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

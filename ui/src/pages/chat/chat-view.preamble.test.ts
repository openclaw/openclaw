/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { message, nativeMessage, queued, signedText } from "./chat-thread-fixtures.test-support.ts";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createTestTranscript, renderChatInto, waitForElement } from "./chat-view.test-helpers.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

const runId = "run-preamble";
const activeTool = message("toolResult", "Read complete.", undefined, {
  toolName: "read",
  toolCallId: "active-read",
  runId,
});
const user = nativeMessage("user", "Check the workspace.", 1, {
  id: "user-preamble",
  idempotencyKey: runId + ":user",
});
const preamble = (text: string, timestamp: number, itemId: string, owner = runId) =>
  message("assistant", text, timestamp, {
    runId: owner,
    openclawStreamFallback: { source: "segment", itemId, runId: owner, replacementText: text },
  });
const draw = (container: HTMLElement, overrides: Parameters<typeof renderChatInto>[1]) =>
  renderChatInto(container, { runActive: true, runId, streamStartedAt: 1, ...overrides });
const narration = (container: HTMLElement) =>
  container.querySelectorAll(".chat-group.assistant .chat-text");
const content = (container: HTMLElement) =>
  Array.from(narration(container), (element) => element.textContent?.trim());

it("keeps successive commentary inline and formatted across the live-to-history handoff", async () => {
  const container = createComposerContainer();
  const earlier = preamble("Reading the files.", 2, "read");
  const detail = "Checking the caller and its lifecycle. ".repeat(25);
  const text = "**Checking** tests.\n\n" + detail + "End of the explanation.";
  const messages = [user, earlier];
  draw(container, {
    messages,
    streamSegments: [{ text, ts: 3, runId, itemId: "test" }],
  });
  await waitForSolid(() =>
    expect(content(container)).toEqual(["Reading the files.", expect.stringContaining(detail)]),
  );
  expect(narration(container)[1]?.querySelector("strong")?.textContent).toBe("Checking");
  expect(narration(container)[1]?.textContent).toContain("End of the explanation.");
  expect(container.querySelector(".chat-working-indicator")?.textContent).not.toContain("Checking");

  draw(container, {
    messages: [...messages, preamble(text, 3, "test")],
    streamSegments: [{ text: "Reviewing the result.", ts: 4, runId, itemId: "review" }],
  });
  expect(content(container)).toEqual([
    "Reading the files.",
    expect.stringContaining(detail),
    "Reviewing the result.",
  ]);
  expect(container.textContent?.match(/End of the explanation\./g)).toHaveLength(1);
  expect(container.querySelector(".chat-working-indicator")?.textContent).not.toContain(
    "Reviewing",
  );
});

it.each(["explicit", "segment", "tool", "cached"] as const)(
  "keeps only active durable commentary with %s run identity when retention is off",
  async (source) => {
    const container = createComposerContainer();
    const props = {
      runId: source === "explicit" ? runId : null,
      stream: source === "explicit" ? null : "Still checking.",
      persistCommentary: false,
      messages: [
        preamble("Older run's commentary.", 0, "old", "old-run"),
        user,
        preamble("Checking the result.", 2, "check"),
      ],
      queue: [
        queued("future-send", "Run this next.", 10, "waiting-reconnect", {
          sendRunId: "future-run",
          sendSubmittedAtMs: 1,
          sendAttempts: 1,
        }),
      ],
    };
    const segment: ChatStreamSegment = { text: "", ts: 1, runId };
    if (source === "cached") {
      draw(container, { ...props, messages: [user], streamSegments: [segment] });
      await flushDeferredRowPrune();
    }
    draw(container, {
      ...props,
      streamSegments: source === "segment" ? [segment] : [],
      toolMessages: source === "tool" ? [activeTool] : [],
    });
    await flushDeferredRowPrune();
    expect(content(container)).toContain("Checking the result.");
    expect(container.textContent).not.toContain("Older run's commentary.");
    draw(container, { ...props, runActive: false, runId: null, stream: null });
    await flushDeferredRowPrune();
    expect(container.textContent).not.toContain("Checking the result.");
  },
);

it("leaves unphased answers and mixed-phase narration and final text in the transcript", () => {
  const container = createComposerContainer();
  renderChatInto(container, {
    runActive: true,
    runId,
    messages: [
      user,
      { role: "assistant", content: "Unphased answer.", timestamp: 2, runId },
      message(
        "assistant",
        [
          signedText("Checking once more.", "commentary", "check"),
          signedText("The result is ready.", "final_answer", "answer"),
        ],
        3,
        { phase: "commentary", runId },
      ),
    ],
  });
  const text = content(container).join("\n");
  expect(text).toContain("Unphased answer.");
  expect(text).toContain("The result is ready.");
  expect(text).toContain("Checking once more.");
  expect(container.textContent?.match(/Checking once more\./g)).toHaveLength(1);
});

it("announces a run preamble and its later terminal answer separately", async () => {
  const builder = vi.spyOn(chatThread, "buildCachedChatItems");
  onTestFinished(() => builder.mockRestore());
  const transcript = createTestTranscript();
  const container = createComposerContainer();
  const user = {
    kind: "group",
    key: "group:user:announcement",
    role: "user",
    visibleContent: "text",
    messages: [
      {
        key: "message:user:announcement",
        message: {
          role: "user",
          content: "Start",
          __openclaw: { id: "user:announcement", idempotencyKey: "run-announcement:user" },
        },
      },
    ],
    timestamp: 1,
    isStreaming: false,
  };
  const renderItems = (items: ReturnType<typeof chatThread.buildCachedChatItems>) => {
    vi.mocked(chatThread.buildCachedChatItems).mockReturnValue(items);
    renderChatInto(container, { transcript, messages: items });
  };

  renderItems([user] as ReturnType<typeof chatThread.buildCachedChatItems>);
  await waitForElement(container, ".chat-virtual-row");
  const stream = {
    kind: "stream" as const,
    key: "stream:announcement",
    text: "Latest streamed narration",
    startedAt: 2,
    isStreaming: true,
    runId: "run-announcement",
    boundaryId: "send:run-announcement",
  };
  renderItems([
    user,
    stream,
    {
      kind: "reading-indicator",
      key: "reading:announcement",
      startedAt: 2,
      runId: "run-announcement",
      boundaryId: "send:run-announcement",
    },
  ] as ReturnType<typeof chatThread.buildCachedChatItems>);

  expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
    "Latest streamed narration",
  );

  renderItems([
    user,
    {
      kind: "group",
      key: "group:assistant:persisted-announcement",
      role: "assistant",
      visibleContent: "text",
      messages: [
        {
          key: "assistant:persisted-announcement",
          message: {
            role: "assistant",
            content: "Persisted narration while the run continues",
            runId: "run-announcement",
          },
        },
      ],
      timestamp: 3,
      isStreaming: false,
      runId: "run-announcement",
    },
    {
      kind: "reading-indicator",
      key: "reading:persisted-announcement",
      startedAt: 4,
      runId: "run-announcement",
      boundaryId: "send:run-announcement",
    },
  ] as ReturnType<typeof chatThread.buildCachedChatItems>);

  expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
    "Persisted narration while the run continues",
  );

  renderItems([
    user,
    { ...stream, isStreaming: false },
    {
      kind: "group",
      key: "group:tool:announcement",
      role: "tool",
      visibleContent: "text",
      messages: [
        {
          key: "tool:announcement",
          message: {
            role: "toolResult",
            content: "Tool output",
            runId: "run-announcement",
          },
        },
      ],
      timestamp: 3,
      isStreaming: false,
      runId: "run-announcement",
    },
    {
      kind: "group",
      key: "group:assistant:announcement",
      role: "assistant",
      visibleContent: "text",
      messages: [
        {
          key: "assistant:announcement",
          message: {
            role: "assistant",
            phase: "final_answer",
            content: "Terminal answer",
            runId: "run-announcement",
          },
        },
      ],
      timestamp: 4,
      isStreaming: false,
      runId: "run-announcement",
    },
  ] as ReturnType<typeof chatThread.buildCachedChatItems>);

  expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
    "Terminal answer",
  );
});

/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChatStreamSegment } from "../../lib/chat/chat-types.ts";
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

const runId = "run-preamble";
const user = {
  role: "user",
  content: "Check the workspace.",
  timestamp: 1,
  __openclaw: { id: "user-preamble", idempotencyKey: runId + ":user" },
};
const preamble = (text: string, timestamp: number, itemId: string, owner = runId) => ({
  role: "assistant",
  content: text,
  timestamp,
  runId: owner,
  openclawStreamFallback: { source: "segment", itemId, runId: owner, replacementText: text },
});

it("keeps successive commentary inline and formatted across the live-to-history handoff", () => {
  const container = document.createElement("div");
  const earlier = preamble("Reading the files.", 2, "read");
  const detail = "Checking the caller and its lifecycle. ".repeat(25);
  const text = "**Checking** tests.\n\n" + detail + "End of the explanation.";
  const props = { runActive: true, runId, messages: [user, earlier], streamStartedAt: 1 };
  renderChatInto(container, {
    ...props,
    streamSegments: [{ text, ts: 3, runId, itemId: "test" }],
  });
  const narration = () => container.querySelectorAll(".chat-group.assistant .chat-text");
  const content = () => Array.from(narration(), (element) => element.textContent?.trim());
  expect(content()).toEqual(["Reading the files.", expect.stringContaining(detail)]);
  expect(narration()[1]?.querySelector("strong")?.textContent).toBe("Checking");
  expect(narration()[1]?.textContent).toContain("End of the explanation.");
  expect(container.querySelector(".chat-working-indicator")?.textContent).not.toContain("Checking");

  renderChatInto(container, {
    ...props,
    messages: [...props.messages, preamble(text, 3, "test")],
    streamSegments: [{ text: "Reviewing the result.", ts: 4, runId, itemId: "review" }],
  });
  expect(content()).toEqual([
    "Reading the files.",
    expect.stringContaining(detail),
    "Reviewing the result.",
  ]);
  expect(container.textContent?.match(/End of the explanation\./g)).toHaveLength(1);
  expect(container.querySelector(".chat-working-indicator")?.textContent).not.toContain(
    "Reviewing",
  );
});

it("keeps only the active run's durable commentary inline when commentary retention is off", () => {
  const container = document.createElement("div");
  const old = preamble("Older run's commentary.", 0, "old", "old-run");
  const messages = [old, user, preamble("Checking the result.", 2, "check")];
  renderChatInto(container, {
    runActive: true,
    runId,
    messages,
    streamStartedAt: 1,
    persistCommentary: false,
  });
  expect(container.querySelector(".chat-group.assistant .chat-text")?.textContent?.trim()).toBe(
    "Checking the result.",
  );
  expect(container.textContent).not.toContain("Older run's commentary.");
  renderChatInto(container, {
    runActive: false,
    runId: null,
    messages,
    persistCommentary: false,
  });
  expect(container.textContent).not.toContain("Checking the result.");
  renderChatInto(container, { messages, persistCommentary: true });
  expect(container.textContent).toContain("Checking the result.");
  expect(messages).toHaveLength(3);
});

it.each(["segment", "tool", "cached"] as const)(
  "keeps durable commentary for a run inferred from %s activity when retention is off",
  (source) => {
    const container = document.createElement("div");
    const props = {
      runActive: true,
      runId: null,
      stream: "Still checking.",
      streamStartedAt: 1,
      persistCommentary: false,
      messages: [
        preamble("Older run's commentary.", 0, "old", "old-run"),
        user,
        preamble("Checking the result.", 2, "check"),
      ],
      queue: [
        {
          id: "future-send",
          text: "Run this next.",
          createdAt: 10,
          sendRunId: "future-run",
          sendState: "waiting-reconnect" as const,
          sendSubmittedAtMs: 1,
          sendAttempts: 1,
        },
      ],
    };
    const boundary: ChatStreamSegment = { text: "", ts: 1, runId, boundaryMarker: true };
    if (source === "cached") {
      renderChatInto(container, { ...props, messages: [user], streamSegments: [boundary] });
    }
    renderChatInto(container, {
      ...props,
      streamSegments: source === "segment" ? [boundary] : [],
      toolMessages:
        source === "tool"
          ? [
              {
                role: "toolResult",
                toolName: "read",
                toolCallId: "active-read",
                runId,
                content: "Read complete.",
              },
            ]
          : [],
    });
    expect(container.textContent).toContain("Checking the result.");
    expect(container.textContent).not.toContain("Older run's commentary.");
    renderChatInto(container, { ...props, runActive: false, stream: null });
    expect(container.textContent).not.toContain("Checking the result.");
  },
);

it("leaves unphased answers and mixed-phase narration and final text in the transcript", () => {
  const container = document.createElement("div");
  renderChatInto(container, {
    runActive: true,
    runId,
    messages: [
      user,
      { role: "assistant", content: "Unphased answer.", timestamp: 2, runId },
      {
        role: "assistant",
        phase: "commentary",
        runId,
        timestamp: 3,
        content: [
          {
            type: "text",
            text: "Checking once more.",
            textSignature: JSON.stringify({ v: 1, id: "check", phase: "commentary" }),
          },
          {
            type: "text",
            text: "The result is ready.",
            textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
          },
        ],
      },
    ],
  });
  const narration = Array.from(
    container.querySelectorAll(".chat-group.assistant .chat-text"),
    (element) => element.textContent,
  ).join("\n");
  expect(narration).toContain("Unphased answer.");
  expect(narration).toContain("The result is ready.");
  expect(narration).toContain("Checking once more.");
  expect(container.textContent?.match(/Checking once more\./g)).toHaveLength(1);
});

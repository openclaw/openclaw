/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
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
  __openclaw: { id: "user-preamble", idempotencyKey: `${runId}:user` },
};
const preamble = (text: string, timestamp: number, itemId: string) => ({
  role: "assistant",
  content: text,
  timestamp,
  runId,
  openclawStreamFallback: { source: "segment", itemId, runId, replacementText: text },
});

it("replaces the live status with the latest owned commentary without duplicating it", () => {
  const container = document.createElement("div");
  const earlier = preamble("Reading the files.", 2, "read");
  const props = { runActive: true, runId, messages: [user, earlier], streamStartedAt: 1 };
  renderChatInto(container, {
    ...props,
    streamSegments: [{ text: "**Checking** tests.", ts: 3, runId, itemId: "test" }],
  });
  const status = () => container.querySelector(".chat-working-indicator__preamble");
  expect(status()?.textContent).toBe("Checking tests.");
  expect(container.textContent?.match(/Checking tests\./g)).toHaveLength(1);
  expect(container.textContent).toContain("Reading the files.");

  // Same status identity, different content: exercise the continuation render cache.
  renderChatInto(container, {
    ...props,
    streamSegments: [
      { text: "Checking tests.", ts: 3, runId, itemId: "test" },
      { text: "Reviewing the result.", ts: 4, runId, itemId: "review" },
      { text: "Another run.", ts: 5, runId: "sibling", itemId: "foreign" },
    ],
  });
  expect(status()?.textContent).toBe("Reviewing the result.");
  expect(container.textContent?.match(/Reviewing the result\./g)).toHaveLength(1);
  expect(container.querySelector("openclaw-working-phrase")).toBeNull();
});

it("keeps the latest durable preamble live with history hidden, then clears on settlement", () => {
  const container = document.createElement("div");
  const messages = [user, preamble("Checking the result.", 2, "check")];
  renderChatInto(container, {
    runActive: true,
    runId,
    messages,
    streamStartedAt: 1,
    persistCommentary: false,
  });
  expect(container.querySelector(".chat-working-indicator__preamble")?.textContent).toBe(
    "Checking the result.",
  );
  renderChatInto(container, {
    runActive: false,
    runId: null,
    messages,
    persistCommentary: false,
  });
  expect(container.querySelector(".chat-working-indicator__preamble")).toBeNull();
  expect(container.textContent).not.toContain("Checking the result.");
  renderChatInto(container, { messages, persistCommentary: true });
  expect(container.textContent).toContain("Checking the result.");
  expect(messages).toHaveLength(2);
});

it("leaves unphased answers and mixed-phase final text in the transcript", () => {
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
  expect(container.textContent).toContain("Unphased answer.");
  expect(container.textContent).toContain("The result is ready.");
  expect(container.querySelector(".chat-working-indicator__preamble")?.textContent).toBe(
    "Checking once more.",
  );
  expect(container.textContent?.match(/Checking once more\./g)).toHaveLength(1);
});

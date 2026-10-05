import { expect, it } from "vitest";
import { buildCachedChatItems } from "./chat-thread.ts";

function render(
  streamSegments: Array<{ text: string; ts: number; runId: string; itemId: string }>,
) {
  return buildCachedChatItems({
    paneId: "commentary-replay",
    sessionKey: "agent:test:main",
    runId: "run-current",
    messages: [
      {
        role: "user",
        content: "Start",
        timestamp: 1000,
        __openclaw: { id: "user-1", seq: 1, runId: "run-earlier" },
      },
      {
        role: "assistant",
        content: "Earlier status",
        timestamp: 1100,
        __openclaw: { id: "commentary-1", seq: 2, runId: "run-earlier" },
        openclawStreamFallback: {
          source: "segment",
          itemId: "commentary-item-1",
          replacementText: "Earlier status",
        },
      },
      {
        role: "user",
        content: "Later question",
        timestamp: 2000,
        __openclaw: { id: "user-2", seq: 3, runId: "run-current" },
      },
    ],
    toolMessages: [],
    streamSegments,
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  });
}

it("does not replay an earlier durable commentary as a live segment", () => {
  const items = render([
    { text: "Earlier status", ts: 1100, runId: "run-earlier", itemId: "commentary-item-1" },
  ]);
  expect(items.some((item) => item.kind === "stream" && item.text === "Earlier status")).toBe(
    false,
  );
});

it("still renders genuinely new keyed commentary", () => {
  const items = render([
    { text: "New status", ts: 2200, runId: "run-current", itemId: "commentary-item-2" },
  ]);
  expect(items.some((item) => item.kind === "stream" && item.text === "New status")).toBe(true);
});

it("keeps a live segment when another run reuses the saved item ID", () => {
  const items = render([
    { text: "Current-run status", ts: 2200, runId: "run-current", itemId: "commentary-item-1" },
  ]);
  expect(items.some((item) => item.kind === "stream" && item.text === "Current-run status")).toBe(
    true,
  );
});

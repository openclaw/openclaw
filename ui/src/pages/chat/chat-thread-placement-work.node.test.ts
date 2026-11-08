// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { message, toolResult } from "./chat-thread-fixtures.test-support.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";
import * as causalBoundary from "./stream-causal-boundary.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetChatThreadState();
});

it("does not repeat history placement scans for sibling live tools", () => {
  const scans = vi.spyOn(causalBoundary, "knownStreamCausalInterval");
  const measure = (count: number) => {
    scans.mockClear();
    const groups = buildCachedChatItems(
      createProps({
        runId: "live-run",
        messages: [message("user", "Earlier prompt", 1), message("assistant", "Earlier reply", 2)],
        toolMessages: Array.from({ length: count }, (_, index) =>
          toolResult(`live-${index}`, "shell", `Result ${index}`, index + 3, {
            runId: "live-run",
          }),
        ),
      }),
    ).filter((item) => item.kind === "group");
    const cards = groups.flatMap((group) =>
      group.messages.flatMap(({ message: source }) => extractToolCardsCached(source)),
    );
    expect(cards).toHaveLength(count);
    return scans.mock.calls.length;
  };
  const single = measure(1);
  expect(single).toBeGreaterThan(0);
  expect(measure(50)).toBe(single);
});

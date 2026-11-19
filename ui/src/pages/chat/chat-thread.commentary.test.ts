// @vitest-environment node
import { expect, it } from "vitest";
import { message, toolResult } from "./chat-thread-fixtures.test-support.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { coalesceActivityRuns, coalesceStreamRuns } from "./chat-turn-presentation.ts";

it("hides disabled durable commentary but keeps the activity runs around it apart", () => {
  const text = "Checking the workspace.";
  const fallback = { replacementText: text, source: "segment", itemId: "preamble-1" };
  const items = buildItems({
    persistCommentary: false,
    messages: [
      message("user", "do it", 1_000),
      toolResult("before-a", "read", "a", 1_100),
      toolResult("before-b", "read", "b", 1_200),
      message("assistant", text, 2_000, { openclawStreamFallback: fallback }),
      toolResult("after-a", "read", "c", 2_100),
      toolResult("after-b", "read", "d", 2_200),
    ],
  });
  expect(JSON.stringify(items)).not.toContain(text);
  const runs = coalesceActivityRuns(coalesceStreamRuns(items));
  expect(runs.filter((item) => item.kind === "activity-run")).toHaveLength(2);
});

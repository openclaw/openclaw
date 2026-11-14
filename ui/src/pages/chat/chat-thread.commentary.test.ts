// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import { message, toolResult as resultMessage } from "./chat-thread-fixtures.test-support.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";
import { coalesceActivityRuns, coalesceStreamRuns } from "./chat-turn-presentation.ts";

beforeEach(() => resetChatThreadState());
const user = message.bind(null, "user");
const assistant = message.bind(null, "assistant");

it("hides durable commentary when the display preference is disabled", () => {
  const paneId = "commentary-visibility";
  const messages = [
    user("do it", 1_000),
    assistant("Checking the workspace.", 2_000, {
      openclawStreamFallback: {
        replacementText: "Checking the workspace.",
        source: "segment",
        itemId: "preamble-1",
      },
    }),
    assistant("All done.", 3_000),
  ];

  const visible = buildItems({ paneId, messages });
  const hidden = buildItems({ paneId, messages, persistCommentary: false });
  const restored = buildItems({ paneId, messages });

  expect(visible.filter((item) => item.kind === "group")).toHaveLength(3);
  expect(hidden.filter((item) => item.kind === "group")).toHaveLength(2);
  expect(restored.filter((item) => item.kind === "group")).toHaveLength(3);
  expect(messages).toHaveLength(3);
  const separated = buildItems({
    paneId,
    persistCommentary: false,
    messages: [
      messages[0],
      resultMessage("before-a", "read", "a", 1_100),
      resultMessage("before-b", "read", "b", 1_200),
      messages[1],
      resultMessage("after-a", "read", "c", 2_100),
      resultMessage("after-b", "read", "d", 2_200),
      messages[2],
    ],
  });
  expect(
    coalesceActivityRuns(coalesceStreamRuns(separated)).filter(
      (item) => item.kind === "activity-run",
    ),
  ).toHaveLength(2);
  resetChatThreadState(paneId);
});

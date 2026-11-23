// @vitest-environment node
import { expect, it } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { subagentCompletionMessage } from "../../../../src/shared/subagent-completion.js";
import { buildPendingInputQueueItems } from "./chat-pending-input-presentation.ts";
import { selectChatInputDisplay } from "./history-merge.ts";

const completion = subagentCompletionMessage({}, [
  { runId: "child-run", sessionKey: "agent:main:subagent:child", label: "Inspect example" },
]);

function input(id: string, message: unknown): ChatPendingInputsPage["items"][number] {
  return { id, runId: id, message, acceptedAt: 100, state: "queued", queued: true };
}

it("keeps completion receipts out of the composer queue without hiding text or attachment-only input", () => {
  const receipt = input("completion", completion);
  const text = input("text", {
    role: "user",
    content: [{ type: "text", text: "Check the example" }],
    subagentCompletions: completion.subagentCompletions,
  });
  const attachment = input("attachment", {
    role: "user",
    content: [],
    __openclaw: {
      media: [
        {
          url: "media://inbound/example.png",
          contentType: "image/png",
          fileName: "example.png",
        },
      ],
    },
  });
  const inputs = [text, receipt, attachment];

  const expected = [
    { id: "pending-input:text", text: "Check the example" },
    { id: "pending-input:attachment", text: "example.png" },
  ];
  expect(buildPendingInputQueueItems(inputs)).toMatchObject(expected);
  expect(
    buildPendingInputQueueItems(selectChatInputDisplay([], [], inputs).queuedInputs),
  ).toMatchObject(expected);
});

it("retains completion receipts for transcript presentation outside the composer queue", () => {
  const receipt = { ...input("completion", completion), queued: undefined };

  expect(selectChatInputDisplay([], [], [receipt])).toMatchObject({
    pendingInputs: [receipt],
    queuedInputs: [],
  });
});

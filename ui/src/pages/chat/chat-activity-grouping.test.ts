// @vitest-environment node
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { message as chatMessage, toolResult } from "./chat-thread-fixtures.test-support.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { coalesceActivityRuns } from "./chat-turn-presentation.ts";

function preparedGroup(message: unknown, key: string): MessageGroup {
  const [group] = groupMessages([{ kind: "message", key, message }], {}, undefined, true);
  assert(group?.kind === "group", "expected a prepared message group");
  return group;
}

const projectedToolGroups = () =>
  [1, 2, 3].map((index) =>
    preparedGroup(
      toolResult("call-" + index, "bash", "ok", index * 1000, {
        __openclaw: { id: "tool-" + index, seq: index, turnBoundary: true },
      }),
      "tool-" + index,
    ),
  );

function requireActivityRun(value: ReturnType<typeof coalesceActivityRuns>[number] | undefined) {
  assert(value?.kind === "activity-run", "expected an activity run");
  return value;
}

it("pools legacy assistant activity with stable keys and message order", () => {
  const groups = [1, 2, 3].map((index): MessageGroup => {
    const tool = { id: `hb-call-${index}`, name: "heartbeat_respond" };
    const content = [
      { ...tool, type: "toolCall", arguments: {} },
      { ...tool, type: "toolResult", text: "ok" },
    ];
    return Object.assign(
      preparedGroup(
        chatMessage("assistant", content, 1_000 * index, { runId: `hb-run-${index}` }),
        `hb-${index}`,
      ),
      { role: "assistant", visibleContent: "none" as const },
    );
  });
  const prompt = preparedGroup(chatMessage("user", "Start", 500), "prompt");
  for (const count of [2, 3]) {
    const expected = groups.slice(0, count);
    const result = coalesceActivityRuns([prompt, ...expected]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(prompt);
    const run = requireActivityRun(result[1]);
    expect(run.key).toBe(`activity:${groups[0]!.key}`);
    expect(run.groups).toEqual(expected);
    run.groups.forEach((group, index) => expect(group).toBe(expected[index]));
  }
});

const assistantToolContent = [
  { type: "toolCall", id: "boundary-tool", name: "read", arguments: {} },
];
it.each([
  { name: "visible reply", content: "Done." },
  { name: "user", role: "user", content: "stop" },
  { name: "divider", content: [] },
  { name: "stream", content: [] },
  { name: "reasoning", content: [{ type: "thinking", thinking: "Inspecting" }] },
  {
    name: "mixed commentary",
    content: [{ type: "text", text: "Checking" }, ...assistantToolContent],
    phase: "commentary",
  },
  { name: "explicit final", content: assistantToolContent, phase: "final_answer" },
  { name: "failed run", content: assistantToolContent, stopReason: "error" },
  { name: "interrupted run", content: assistantToolContent, stopReason: "timeout" },
  {
    name: "projected source",
    content: assistantToolContent,
    senderSession: { sessionKey: "agent:other:main", label: "Review" },
  },
  {
    name: "media",
    content: [{ type: "image", source: { type: "url", url: "https://example.com/proof.png" } }],
  },
  {
    name: "forwarded input",
    content: "Message from the parent session.",
    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
  },
])("keeps $name between activity logs", ({ name, ...fields }) => {
  const groups = projectedToolGroups();
  const boundary =
    name === "divider"
      ? { kind: "divider" as const, key: "divider:boundary", label: "Boundary", timestamp: 5_000 }
      : name === "stream"
        ? { kind: "stream-run" as const, key: "stream-run:live", runId: "run-2", parts: [] }
        : preparedGroup(
            chatMessage("assistant", fields.content, 2_000, { ...fields, runId: "run-2" }),
            "boundary",
          );
  const first = { ...groups[0]!, runId: "run-1" };
  const second = { ...groups[1]!, runId: "run-2" };
  const projected = coalesceActivityRuns([first, second, boundary, groups[2]!]);
  expect(projected).toHaveLength(3);
  expect(requireActivityRun(projected[0]).groups).toEqual([first, second]);
  expect(projected[1]).toBe(boundary);
  expect(projected[2]).toBe(groups[2]);
});

it("disables projection during search", () => {
  const searchInput = projectedToolGroups().slice(0, 2);
  expect(coalesceActivityRuns(searchInput, { searchActive: true })).toBe(searchInput);
});

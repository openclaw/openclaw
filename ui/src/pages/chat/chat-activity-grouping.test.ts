// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { coalesceActivityRuns, groupMessages } from "./chat-thread-grouping.ts";

function preparedGroup(message: unknown, key: string): MessageGroup {
  const [group] = groupMessages([{ kind: "message", key, message }]);
  if (group?.kind !== "group") {
    throw new Error("expected a prepared message group");
  }
  return group;
}

function messageEntry(key: string, message: unknown): MessageGroup["messages"][number] {
  const entry = preparedGroup(message, key).messages[0];
  if (!entry) {
    throw new Error("expected a prepared message entry");
  }
  return entry;
}

function assistantMessage(
  content: unknown,
  timestamp: number,
  overrides: Record<string, unknown> = {},
) {
  return { role: "assistant", content, timestamp, ...overrides };
}

function userMessage(content: string, timestamp: number, overrides: Record<string, unknown> = {}) {
  return { role: "user", content, timestamp, ...overrides };
}

describe("coalesceActivityRuns", () => {
  const projectedToolGroups = () =>
    [1, 2, 3].map((index) =>
      preparedGroup(
        {
          role: "toolResult",
          toolCallId: "call-" + index,
          toolName: "bash",
          content: "ok",
          timestamp: index * 1000,
          __openclaw: { id: "tool-" + index, seq: index, turnBoundary: true },
        },
        "tool-" + index,
      ),
    );

  function requireActivityRun(value: ReturnType<typeof coalesceActivityRuns>[number] | undefined) {
    if (value?.kind !== "activity-run") {
      throw new Error("expected an activity run");
    }
    return value;
  }

  it.each(["tool", "assistant"])(
    "pools reply-less %s runs with stable keys and message order",
    (role) => {
      const groups =
        role === "tool"
          ? projectedToolGroups().map((group, index) =>
              Object.assign({}, group, { runId: `run-${index}` }),
            )
          : [1, 2, 3].map((index): MessageGroup => ({
              kind: "group",
              key: `group:assistant:hb-${index}`,
              role: "assistant",
              messages: [
                messageEntry(
                  `hb-${index}`,
                  assistantMessage(
                    [
                      {
                        type: "toolCall",
                        id: `hb-call-${index}`,
                        name: "heartbeat_respond",
                        arguments: {},
                      },
                      {
                        type: "toolResult",
                        id: `hb-call-${index}`,
                        name: "heartbeat_respond",
                        text: "ok",
                      },
                    ],
                    1_000 * index,
                    { runId: `hb-run-${index}` },
                  ),
                ),
              ],
              visibleContent: "none",
              timestamp: 1_000 * index,
              isStreaming: false,
              runId: `hb-run-${index}`,
            }));
      const prompt = preparedGroup(
        userMessage("Start", 500, { __openclaw: { idempotencyKey: "run-1:user" } }),
        "prompt",
      );
      const initial = coalesceActivityRuns([prompt, ...groups.slice(0, 2)]);
      const appended = coalesceActivityRuns([prompt, ...groups]);
      expect(initial).toHaveLength(2);
      expect(appended).toHaveLength(2);
      expect(initial[0]).toBe(prompt);
      expect(appended[0]).toBe(prompt);
      const run = requireActivityRun(initial[1]);
      expect(run.groups).toEqual(groups.slice(0, 2));
      expect(run.groups[0]).toBe(groups[0]);
      expect(run.groups[1]).toBe(groups[1]);
      expect(run.key).toBe(`activity:${groups[0]!.key}`);
      expect(requireActivityRun(appended[1]).key).toBe(run.key);
      expect(requireActivityRun(appended[1]).groups).toEqual(groups);
      expect(run.groups.flatMap((group) => group.messages.map((entry) => entry.key))).toEqual(
        groups.slice(0, 2).flatMap((group) => group.messages.map((entry) => entry.key)),
      );
    },
  );

  const assistantToolContent = [
    { type: "toolCall", id: "boundary-tool", name: "read", arguments: {} },
  ];
  it.each([
    { name: "commentary", content: "Checking", phase: "commentary" },
    { name: "visible reply", content: "Done." },
    { name: "user", role: "user", content: "stop" },
    { name: "divider", content: [] },
    { name: "stream", content: [] },
    { name: "empty output", content: [] },
    { name: "reasoning", content: [{ type: "thinking", thinking: "Inspecting" }] },
    {
      name: "mixed narration",
      content: [{ type: "text", text: "Checking" }, ...assistantToolContent],
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
      content: [],
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    },
  ])("keeps $name between activity logs", ({ name, ...message }) => {
    const groups = projectedToolGroups();
    const boundary =
      name === "divider"
        ? { kind: "divider" as const, key: "divider:boundary", label: "Boundary", timestamp: 5_000 }
        : name === "stream"
          ? { kind: "stream-run" as const, key: "stream-run:live", runId: "run-2", parts: [] }
          : preparedGroup(
              assistantMessage(message.content, 2_000, { ...message, runId: "run-2" }),
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

  it("leaves a single tool group unchanged and disables projection during search", () => {
    const groups = projectedToolGroups();
    const singleton = coalesceActivityRuns([groups[0]!]);
    const searchInput = groups.slice(0, 2);

    expect(singleton[0]).toBe(groups[0]);
    expect(coalesceActivityRuns(searchInput, { searchActive: true })).toBe(searchInput);
  });
});

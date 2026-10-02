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

  it("combines projected-turn tool groups without rewriting their order or messages", () => {
    const groups = projectedToolGroups();
    const projected = coalesceActivityRuns(groups.slice(0, 2));
    const run = requireActivityRun(projected[0]);

    expect(projected).toHaveLength(1);
    expect(run.groups).toEqual([groups[0], groups[1]]);
    expect(run.groups[0]).toBe(groups[0]);
    expect(run.groups[1]).toBe(groups[1]);
    expect(run.groups.flatMap((group) => group.messages.map((entry) => entry.key))).toEqual(
      groups.slice(0, 2).flatMap((group) => group.messages.map((entry) => entry.key)),
    );
  });

  it("keeps the first-group key stable when live tool groups append", () => {
    const groups = projectedToolGroups();
    const initial = requireActivityRun(coalesceActivityRuns(groups.slice(0, 2))[0]);
    const appended = requireActivityRun(coalesceActivityRuns(groups)[0]);

    expect(initial.key).toBe(`activity:${groups[0]?.key}`);
    expect(appended.key).toBe(initial.key);
  });

  it("merges adjacent tool activity without absorbing the visible reply", () => {
    const groups = projectedToolGroups();
    const first = { ...groups[0]!, runId: "run-1" };
    const second = { ...groups[1]!, runId: "run-2" };
    const reply: MessageGroup = {
      kind: "group",
      key: "group:assistant:reply",
      role: "assistant",
      messages: [messageEntry("assistant:reply", assistantMessage("Done.", 3_500))],
      visibleContent: "text",
      timestamp: 3_500,
      isStreaming: false,
      runId: "run-2",
    };

    const projected = coalesceActivityRuns([first, second, reply]);
    expect(projected).toHaveLength(2);
    expect(requireActivityRun(projected[0]).groups).toEqual([first, second]);
    expect(projected[1]).toBe(reply);
  });

  it("pools consecutive reply-less runs' activity into one rollup", () => {
    const groups = projectedToolGroups();
    const runs = groups.map((group, index) =>
      Object.assign({}, group, { runId: `run-${index + 1}` }),
    );
    const prompt = preparedGroup(
      userMessage("Start", 500, {
        __openclaw: { idempotencyKey: "run-1:user" },
      }),
      "prompt",
    );
    const projected = coalesceActivityRuns([prompt, ...runs]);
    const run = requireActivityRun(projected[1]);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toBe(prompt);
    expect(run.groups).toEqual(runs);
  });

  it("pools reply-less assistant tool activity like heartbeat wakes", () => {
    const heartbeatGroup = (index: number): MessageGroup => ({
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
              { type: "toolResult", id: `hb-call-${index}`, name: "heartbeat_respond", text: "ok" },
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
    });
    const beats = [heartbeatGroup(1), heartbeatGroup(2), heartbeatGroup(3)];
    const projected = coalesceActivityRuns(beats);
    const run = requireActivityRun(projected[0]);

    expect(projected).toHaveLength(1);
    expect(run.groups).toEqual(beats);
  });

  it("merges a live run's preceding activity while keeping its stream outside", () => {
    const groups = projectedToolGroups();
    const first = { ...groups[0]!, runId: "run-1" };
    const live = { ...groups[1]!, runId: "run-2" };
    const streamRun = {
      kind: "stream-run" as const,
      key: "stream-run:live",
      runId: "run-2",
      parts: [],
    };

    const projected = coalesceActivityRuns([first, live, streamRun]);
    expect(projected).toHaveLength(2);
    expect(requireActivityRun(projected[0]).groups).toEqual([first, live]);
    expect(projected[1]).toBe(streamRun);
  });

  it("treats every non-tool item as a hard presentation boundary", () => {
    const groups = projectedToolGroups();
    const userBoundary: MessageGroup = {
      kind: "group",
      key: "group:user:boundary",
      role: "user",
      messages: [messageEntry("user:boundary", userMessage("stop", 4_000))],
      visibleContent: "text",
      timestamp: 4_000,
      isStreaming: false,
    };
    const divider = {
      kind: "divider" as const,
      key: "divider:boundary",
      label: "Boundary",
      timestamp: 5_000,
    };
    const projected = coalesceActivityRuns([
      groups[0]!,
      userBoundary,
      groups[1]!,
      divider,
      groups[2]!,
    ]);

    expect(projected).toEqual([groups[0], userBoundary, groups[1], divider, groups[2]]);
  });

  const assistantToolContent = [
    { type: "toolCall", id: "boundary-tool", name: "read", arguments: {} },
  ];
  it.each([
    { name: "commentary", content: "Checking", phase: "commentary" },
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
  ])("keeps $name between activity logs", ({ name: _name, ...message }) => {
    const groups = projectedToolGroups();
    const [boundary] = groupMessages([
      {
        kind: "message",
        key: "boundary",
        message: assistantMessage(message.content, 2_000, { ...message, runId: "boundary-run" }),
      },
    ]);
    if (boundary?.kind !== "group") {
      throw new Error("expected a prepared boundary group");
    }
    expect(coalesceActivityRuns([groups[0]!, boundary, groups[1]!])).toEqual([
      groups[0],
      boundary,
      groups[1],
    ]);
  });

  it("leaves a single tool group unchanged and disables projection during search", () => {
    const groups = projectedToolGroups();
    const singleton = coalesceActivityRuns([groups[0]!]);
    const searchInput = groups.slice(0, 2);

    expect(singleton[0]).toBe(groups[0]);
    expect(coalesceActivityRuns(searchInput, { searchActive: true })).toBe(searchInput);
  });
});

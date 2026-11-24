import { describe, expect, it } from "vitest";
import { summarizeToolGroup } from "./tool-call-grouping.ts";

type ToolGroupSummaryInput = Parameters<typeof summarizeToolGroup>[0][number];

describe("summarizeToolGroup", () => {
  const prepared = (
    itemId: string,
    title: string,
    extra: Partial<ToolGroupSummaryInput> = {},
  ): ToolGroupSummaryInput => ({
    itemId,
    title,
    kind: "tool",
    phase: "end",
    status: "completed",
    ...extra,
  });

  it("distinguishes launched subagents from the launcher's other operations", () => {
    const launches = ["story", "puzzle", "cafe"].map((id) =>
      prepared(`tool:${id}`, "Sub-agent", { name: "sessions_spawn", toolCallId: id }),
    );
    expect(
      summarizeToolGroup([prepared("search", "Find notes", { name: "custom_tool" }), ...launches]),
    ).toBe("Launched subagents");
    expect(summarizeToolGroup(launches.slice(0, 1))).toBe("Launched subagents");
    // A launch that opened a session in its own right is not a subagent.
    expect(summarizeToolGroup(launches, { ownSessionLaunches: new Set(["story"]) })).toBe(
      "Launched subagents",
    );
    // A refused launch started no subagent.
    const refused = prepared("tool:refused", "Sub-agent", {
      name: "sessions_spawn",
      toolCallId: "refused",
      status: "failed",
    });
    expect(summarizeToolGroup([...launches, refused])).toBe("Tool calls, launched subagents");
  });

  it("replaces running state with the same operation's outcome without counting suppressed siblings", () => {
    expect(
      summarizeToolGroup([
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "running", phase: "start" }),
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "failed" }),
        prepared("command:call", "Command", { toolCallId: "call", suppressChannelProgress: true }),
      ]),
    ).toBe("Tool calls");
    const read = prepared("tool:shared", "Read", { name: "read", toolCallId: "shared" });
    const command = prepared("tool:shared", "Command", { name: "exec", toolCallId: "shared" });
    expect(
      summarizeToolGroup([read, command], {
        activityKeys: new Map([
          [read, "run-a:shared"],
          [command, "run-b:shared"],
        ]),
      }),
    ).toBe("Read files, ran commands");
  });

  it("keeps approval and unknown outcomes but leaves failed and skipped steps to their rows", () => {
    expect(
      summarizeToolGroup([
        prepared("quiet", "Wait", { hideFromChannelProgress: true }),
        prepared("failure", "Check process", { status: "failed" }),
        prepared("approval", "Write report", { status: "blocked" }),
        prepared("steering", "Read context", { status: "skipped" }),
        prepared("unknown", "Outcome unknown", { status: undefined }),
        prepared("unpaired", "Run build", { status: undefined, unpairedCall: true }),
      ]),
    ).toBe("Tool calls · Blocked · Outcome unknown");
  });

  it("names a recorded command execution independently of success", () => {
    const command = prepared("command", "Exec", { name: "exec", status: "failed" });
    expect(summarizeToolGroup([command])).toBe("Commands");
    expect(summarizeToolGroup([{ ...command, status: "running" }])).toBe("Running commands");
    const executedCommands = new Set(["command"]);
    expect(summarizeToolGroup([command], { executedCommands })).toBe("Ran commands");
    expect(summarizeToolGroup([{ ...command, status: "skipped" }], { executedCommands })).toContain(
      "Commands",
    );
  });

  it("combines skill exploration with reads and searches beside commands", () => {
    expect(
      summarizeToolGroup([
        prepared("command", "Exec", { name: "exec" }),
        prepared("search", "Skill Search", { name: "skills_search" }),
        prepared("read", "Skill Read", { name: "skills_read" }),
        prepared("wait", "Wait for Agents", { name: "agents_wait" }),
        prepared("question", "Ask User", { name: "ask_user" }),
      ]),
    ).toBe("Read files, ran commands, waited for agents, asked questions");
  });

  it.each([
    ["completed", "completed", "Changed files", "Read and changed files"],
    ["completed", "running", "Changing files", "Read files, changing files"],
    ["failed", "failed", "File changes", "Read files, file changes"],
    [
      undefined,
      undefined,
      "File changes · Outcome unknown",
      "Read files, file changes · Outcome unknown",
    ],
  ] as const)(
    "combines edit and write work without losing its state (%s, %s)",
    (editStatus, writeStatus, expected, withRead) => {
      const actions = [
        prepared("edit", "Edit", { name: "edit", status: editStatus }),
        prepared("write", "Write", { name: "write", status: writeStatus }),
      ];
      expect(summarizeToolGroup(actions)).toBe(expected);
      expect(summarizeToolGroup([prepared("read", "Read", { name: "read" }), ...actions])).toBe(
        withRead,
      );
    },
  );

  it("has no activity label when all prepared work is quiet", () => {
    expect(summarizeToolGroup([])).toBe(
      summarizeToolGroup([prepared("quiet", "Wait", { hideFromChannelProgress: true })]),
    );
    expect(summarizeToolGroup([])).toBe("");
  });

  it("summarizes related work across tools without listing their implementation names", () => {
    const actions = (names: string[]) =>
      names.map((name, index) => prepared(String(index), name, { name }));
    expect(
      summarizeToolGroup(
        actions([
          "exec",
          "read",
          "edit",
          "skills_search",
          "skills_read",
          "get_goal",
          "knowledge_grep",
          "knowledge_record",
          "create_goal",
        ]),
      ),
    ).toBe("Read and changed files, ran commands");
    const memory = actions([
      "sessions_send",
      "knowledge_remember",
      "knowledge_record",
      "knowledge_edit_body",
    ]);
    expect(
      summarizeToolGroup([...memory, prepared("wait", "Wait", { name: "wait", status: "failed" })]),
    ).toBe("Read and updated memory, sent messages, tool calls");
    expect(
      summarizeToolGroup([
        prepared("read", "Memory Get", { name: "memory_get" }),
        prepared("edit", "Edit body", { name: "knowledge_edit_body", status: "failed" }),
      ]),
    ).toBe("Read memory");
  });

  it("keeps unknown-tool summaries bounded as new tools appear and preserves their phase", () => {
    const actions = Array.from({ length: 20 }, (_, index) =>
      prepared(String(index), `Integration action ${index}`, {
        name: `new_plugin_action_${index}`,
      }),
    );
    expect(summarizeToolGroup(actions.slice(0, 2))).toBe("Used tools");
    expect(summarizeToolGroup(actions)).toBe("Used tools");
    expect(summarizeToolGroup([{ ...actions[0]!, status: "running" }])).toBe("Using tools");
    expect(summarizeToolGroup([{ ...actions[0]!, status: "failed" }])).toBe("Tool calls");
  });

  it.each([
    ["skills_search", "completed", "Searched", "Read files"],
    ["skills_search", "running", "Searching", "Read files, searching"],
    ["skills_search", "failed", "Searches", "Read files, searches"],
    ["memory_get", "completed", "Read memory", "Read files"],
    ["knowledge_edit_body", "completed", "Updated memory", "Read files, updated memory"],
  ] as const)(
    "keeps %s (%s) meaningful alone and beside file work",
    (name, status, alone, withRead) => {
      const action = prepared("support", name, { name, status });
      expect(summarizeToolGroup([action])).toBe(alone);
      expect(summarizeToolGroup([prepared("read", "Read", { name: "read" }), action])).toBe(
        withRead,
      );
    },
  );
});

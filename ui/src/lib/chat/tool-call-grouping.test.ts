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
    ).toBe("Called Custom Tool, launched subagents");
    expect(summarizeToolGroup(launches.slice(0, 1))).toBe("Launched subagents");
    // A launch that opened a session in its own right is not a subagent.
    expect(summarizeToolGroup(launches, { ownSessionLaunches: new Set(["story"]) })).toBe(
      "Performed actions, launched subagents",
    );
    // A refused launch started no subagent.
    const refused = prepared("tool:refused", "Sub-agent", {
      name: "sessions_spawn",
      toolCallId: "refused",
      status: "failed",
    });
    expect(summarizeToolGroup([...launches, refused])).toBe(
      "Attempted actions, launched subagents",
    );
  });

  it("replaces running state with the same operation's outcome without counting suppressed siblings", () => {
    expect(
      summarizeToolGroup([
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "running", phase: "start" }),
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "failed" }),
        prepared("command:call", "Command", { toolCallId: "call", suppressChannelProgress: true }),
      ]),
    ).toBe("Attempted actions");
    const read = prepared("tool:shared", "Read", { name: "read", toolCallId: "shared" });
    const command = prepared("tool:shared", "Command", { name: "exec", toolCallId: "shared" });
    expect(
      summarizeToolGroup([read, command], {
        activityKeys: new Map([
          [read, "run-a:shared"],
          [command, "run-b:shared"],
        ]),
      }),
    ).toBe("Ran commands, read files");
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
    ).toBe("Attempted actions · Blocked · Outcome unknown");
  });

  it("names a recorded command execution independently of success", () => {
    const command = prepared("command", "Exec", { name: "exec", status: "failed" });
    expect(summarizeToolGroup([command])).toBe("Attempted commands");
    expect(summarizeToolGroup([{ ...command, status: "running" }])).toBe("Running commands");
    const executedCommands = new Set(["command"]);
    expect(summarizeToolGroup([command], { executedCommands })).toBe("Ran commands");
    for (const status of ["blocked", "skipped"] as const) {
      expect(summarizeToolGroup([{ ...command, status }], { executedCommands })).toContain(
        "Attempted commands",
      );
    }
  });

  it("keeps code executions distinct from shell commands", () => {
    const code = prepared("code", "Exec", { name: "exec" });
    const command = prepared("shell", "Exec", { name: "exec" });
    const codeExecutions = new Set(["code"]);
    expect(summarizeToolGroup([code, command], { codeExecutions })).toBe("Ran code, ran commands");
    expect(summarizeToolGroup([{ ...code, status: "failed" }], { codeExecutions })).toBe(
      "Code execution",
    );
  });

  it("names skill searches and reads as actions beside commands", () => {
    expect(
      summarizeToolGroup([
        prepared("command", "Exec", { name: "exec" }),
        prepared("search", "Skill Search", { name: "skills_search" }),
        prepared("read", "Skill Read", { name: "skills_read" }),
      ]),
    ).toBe("Ran commands, searched skills, read skills");
    expect(
      summarizeToolGroup([
        prepared("search", "Skill Search", { name: "skills_search", status: "running" }),
        prepared("read", "Skill Read", { name: "skills_read", hideFromChannelProgress: true }),
      ]),
    ).toBe("Searching skills");
    expect(
      summarizeToolGroup([
        prepared("command", "Exec", { name: "exec", status: "running" }),
        prepared("search", "Skill Search", { name: "skills_search", status: "running" }),
        prepared("read", "Read", { name: "read", status: "running" }),
      ]),
    ).toBe("Running commands, reading files, searching skills");
  });

  it("has no activity label when all prepared work is quiet", () => {
    expect(summarizeToolGroup([])).toBe(
      summarizeToolGroup([prepared("quiet", "Wait", { hideFromChannelProgress: true })]),
    );
    expect(summarizeToolGroup([])).toBe("");
  });
});

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

  it("counts launched subagents apart from the launcher's other operations", () => {
    const launches = ["story", "puzzle", "cafe"].map((id) =>
      prepared(`tool:${id}`, "Sub-agent", { name: "sessions_spawn", toolCallId: id }),
    );
    expect(
      summarizeToolGroup([prepared("search", "Find notes", { name: "custom_tool" }), ...launches]),
    ).toBe("1 other operation · 3 subagents");
    expect(summarizeToolGroup(launches.slice(0, 1))).toBe("1 subagent");
    // A launch that opened a session in its own right is not a subagent.
    expect(summarizeToolGroup(launches, { ownSessionLaunches: new Set(["story"]) })).toBe(
      "1 other operation · 2 subagents",
    );
    // A refused launch started no subagent.
    const refused = prepared("tool:refused", "Sub-agent", {
      name: "sessions_spawn",
      toolCallId: "refused",
      status: "failed",
    });
    expect(summarizeToolGroup([...launches, refused])).toBe(
      "1 other operation · 3 subagents · 1 failed",
    );
  });

  it("replaces running state with the same operation's outcome without counting suppressed siblings", () => {
    expect(
      summarizeToolGroup([
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "running", phase: "start" }),
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "failed" }),
        prepared("command:call", "Command", { toolCallId: "call", suppressChannelProgress: true }),
      ]),
    ).toBe("1 other operation · 1 failed");
  });

  it("keeps failure, approval, skipped, and unknown outcomes while quiet work stays out", () => {
    expect(
      summarizeToolGroup([
        prepared("quiet", "Wait", { hideFromChannelProgress: true }),
        prepared("failure", "Check process", { status: "failed" }),
        prepared("approval", "Write report", { status: "blocked" }),
        prepared("steering", "Read context", { status: "skipped" }),
        prepared("unknown", "Outcome unknown", { status: undefined }),
      ]),
    ).toBe("4 other operations · 1 failed · 1 blocked · 1 skipped · 1 unknown");
  });

  it("keeps the diagnostic disclosure label when all prepared work is quiet", () => {
    expect(summarizeToolGroup([])).toBe(
      summarizeToolGroup([prepared("quiet", "Wait", { hideFromChannelProgress: true })]),
    );
    expect(summarizeToolGroup([])).not.toBe("");
  });
});

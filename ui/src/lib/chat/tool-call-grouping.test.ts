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

  it("counts prepared operations without copying their free-form titles", () => {
    expect(
      summarizeToolGroup([
        prepared("first", "Check samples", { name: "custom_tool" }),
        prepared("second", "Edit report", { name: "edit" }),
        prepared("third", "Check samples"),
      ]),
    ).toBe("1 edit · 2 other operations");
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

  it("keeps failure, approval, and unknown outcomes while quiet work stays out", () => {
    expect(
      summarizeToolGroup([
        prepared("quiet", "Wait", { hideFromChannelProgress: true }),
        prepared("failure", "Check process", { status: "failed" }),
        prepared("approval", "Write report", { status: "blocked" }),
        prepared("unknown", "Outcome unknown", { status: undefined }),
      ]),
    ).toBe("3 other operations · 1 failed · 1 blocked · 1 unknown");
  });

  it("keeps the diagnostic disclosure label when all prepared work is quiet", () => {
    expect(summarizeToolGroup([])).toBe(
      summarizeToolGroup([prepared("quiet", "Wait", { hideFromChannelProgress: true })]),
    );
    expect(summarizeToolGroup([])).not.toBe("");
  });

  it("bounds dense summaries independently of command, title, and custom-name length", () => {
    const items = Array.from({ length: 500 }, (_, index) =>
      prepared(`call-${index}`, `print text → ${"/workspace/deep/path ".repeat(100)}`, {
        name: index % 2 === 0 ? "exec" : `custom_${"long".repeat(100)}_${index}`,
      }),
    );
    expect(summarizeToolGroup(items)).toBe("250 commands · 250 other operations");
    expect(summarizeToolGroup([prepared("custom", "constructor", { name: "constructor" })])).toBe(
      "1 other operation",
    );
    expect(
      summarizeToolGroup([prepared("command", "Native command", { commandBearing: true })]),
    ).toBe("1 command");
  });
});

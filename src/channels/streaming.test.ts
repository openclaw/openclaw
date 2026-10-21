import { expect, it } from "vitest";
import { inferToolMetaFromArgsCore } from "../agents/tool-display.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import {
  type ChannelProgressDraftLineInput,
  type ChannelStreamingProgressConfig,
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry as buildForEntry,
  formatChannelProgressDraftLineForEntry as formatForEntry,
  formatChannelProgressDraftText as formatText,
  formatPlanChecklistLines as formatChecklist,
  normalizeAgentPlanSteps,
  mergeChannelProgressDraftLine as mergeLine,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingProgressCommentary,
  resolveChannelStreamingProgressNarration,
} from "./streaming.js";

const inheritedBlock = (mode: string) =>
  resolveChannelStreamingBlockEnabled(
    { streaming: { mode } },
    { previewAvailable: true, blockStreamingDefault: "on" },
  );
const rawCommandEntry = { streaming: { progress: { commandText: "raw" } } };
function draftText(
  lines: Parameters<typeof formatText>[0]["lines"],
  progress: ChannelStreamingProgressConfig,
  options: Omit<Parameters<typeof formatText>[0], "lines" | "entry"> = {},
) {
  return formatText({ entry: { streaming: { mode: "progress", progress } }, lines, ...options });
}

it("keeps prepared titles and failure outcomes when detail text is unchanged", () => {
  const input = {
    event: "item" as const,
    itemKind: "tool",
    itemId: "task",
    name: "process",
    title: "Check sample results",
    progressText: "sample job",
  };
  const running = formatForEntry(undefined, { ...input, status: "running" });
  const failed = formatForEntry(undefined, { ...input, status: "failed" });
  expect(running).toContain("Check sample results");
  expect(failed).toContain("Check sample results");
  expect(failed).toContain("failed");
  expect(failed).toContain("sample job");
  expect(failed).not.toBe(running);
});

it("bounds prepared path titles at the configured maxLineChars", () => {
  const maxLineChars = 40;
  const path = `/tmp/${"deep/".repeat(40)}file.txt`;
  const entry = { streaming: { progress: { maxLineChars } } };
  const input = {
    event: "item" as const,
    itemKind: "tool",
    name: "read",
    title: `Read from ${path}`,
    meta: `from ${path}`,
    status: "failed",
  };
  const line = buildForEntry(entry, input, { toolIcons: true });

  expect(line?.label).toContain("…");
  expect(line?.label).toMatch(/file\.txt$/);
  expect(line?.text).toContain("failed");
  expect(Array.from(line!.text).length).toBeLessThanOrEqual(maxLineChars ?? 120);
});

it("keeps plan arguments out of generic tool and item rows", () => {
  const name = "progress_card";
  const args = {
    markdown: '<progress aria-label="CI · 2/3" value="2" max="3"></progress>',
    plan: [{ step: "Inspect", status: "in_progress" }],
  };
  expect(buildChannelProgressDraftLine({ event: "tool", name, args })).toBeUndefined();
  const item = { event: "item" as const, itemKind: "tool", name, meta: args.markdown };
  expect(buildChannelProgressDraftLine(item)).toBeUndefined();
});

it("keeps blocked plan-tool attention without raw argument metadata", () => {
  expect(
    buildChannelProgressDraftLine({
      event: "item",
      itemId: "plan-failed",
      itemKind: "tool",
      name: "progress_card",
      status: "blocked",
      meta: '<progress aria-label="private" value="1" max="2"></progress>',
    }),
  ).toMatchObject({
    id: "plan-failed",
    kind: "item",
    label: "Progress Card",
    status: "blocked",
    text: "Progress Card",
  });
});

it("defaults entry-backed command progress to status and preserves explicit raw text", () => {
  const input = {
    event: "tool" as const,
    name: "exec",
    phase: "start",
    args: { command: "echo private" },
  };

  const line = buildForEntry(undefined, input);
  expect(line?.text).toBe("Exec");
  expect(line?.icon).toBeUndefined();
  expect(draftText(line ? [line, { ...line, icon: "🔧" }] : [], { label: false })).toBe(
    "• Exec\n🔧 Exec",
  );
  expect(buildForEntry(rawCommandEntry, input, { detailMode: "raw" })?.text).toContain(
    "echo private",
  );

  const namespaced = { ...input, name: "server.exec" };
  expect(buildForEntry(undefined, namespaced)?.text).not.toContain("echo private");
  expect(buildForEntry(rawCommandEntry, namespaced)?.text).toContain("echo private");
});
it.each<[ChannelProgressDraftLineInput, string]>([
  [
    {
      event: "command-output",
      name: "exec",
      phase: "end",
      title: "echo private",
      exitCode: 1,
    },
    "exit 1",
  ],
  [
    {
      event: "item",
      itemKind: "command",
      name: "exec",
      phase: "start",
      status: "running",
      meta: "echo private",
    },
    "Exec",
  ],
])("hides command text unless raw output is requested: %j", (input, statusText) => {
  expect(buildChannelProgressDraftLine(input)?.text).toBe(statusText);
  expect(buildChannelProgressDraftLine(input, { commandText: "raw" })?.text).toContain(
    "echo private",
  );
});
it("renders capitalized shell tools and their summary as one line", () => {
  const name = "Bash";
  const args = { command: "echo alpha", description: "print text" };
  const input = { event: "tool" as const, toolCallId: "call-1", name, phase: "start", args };
  const structured = buildChannelProgressDraftLine(input, { commandText: "raw" });
  const meta = inferToolMetaFromArgsCore(name, args, { detailMode: "explain" });
  const summaryText = formatToolAggregate(name, meta ? [meta] : undefined, { markdown: true });

  const merged = mergeLine(
    structured ? [structured] : [],
    { kind: "item", label: "", text: summaryText, prefix: false },
    { maxLines: 8 },
  );

  expect(merged).toHaveLength(1);
  expect(structured).toMatchObject({ detail: "print text", text: "print text" });
});
it("preserves SDK default retention of non-zero exits over newer activity", () => {
  const exit = {
    id: "command-1",
    kind: "command-output" as const,
    label: "Exec",
    text: "exit 1",
    status: "exit 1",
  };
  const lines = mergeLine(
    [exit, { id: "read-1", kind: "tool", label: "Read", text: "Read first file" }],
    { id: "read-2", kind: "tool", label: "Read", text: "Read second file" },
    { maxLines: 2 },
  );

  expect(lines.map((line) => line.text)).toEqual(["exit 1", "Read second file"]);
});
it("normalizes external-plugin string steps and typed entries, dropping blanks", () => {
  expect(
    normalizeAgentPlanSteps([
      "Inspect",
      "  ",
      { step: "  Patch  ", status: "in_progress" },
      { step: "   ", status: "pending" },
      { step: "Test", status: "bogus" },
    ]),
  ).toEqual([
    { step: "Inspect", status: "pending" },
    { step: "Patch", status: "in_progress" },
  ]);
  expect(normalizeAgentPlanSteps(undefined)).toBeUndefined();
});
it.each([
  ["partial", false],
  ["off", true],
  ["invalid", true],
] as const)("resolves inherited block defaults for %s preview", (mode, expected) => {
  expect(inheritedBlock(mode)).toBe(expected);
});

const plan = [
  { step: "Inspect", status: "completed" },
  { step: "Patch", status: "in_progress" },
  { step: "Verify", status: "pending" },
] as const;

it("preserves SDK summary exit priority over a full plan", () => {
  const text = draftText(
    [{ kind: "command-output", label: "Exec", text: "exit 1", status: "exit 1" }],
    { toolProgress: true, label: false, maxLines: 3 },
    { presentation: "summary", plan },
  );

  expect(text).toContain("exit 1");
  expect(text).toContain("Patch");
  expect(text.split("\n").filter(Boolean)).toHaveLength(3);
});

it("renders plan markers and keeps the checklist under narration", () => {
  expect(formatChecklist(plan, { maxLines: 5, maxLineChars: 80 })).toEqual([
    "✅ Inspect",
    "▸ Patch",
    "▢ Verify",
  ]);
  expect(
    draftText(["Exec"], { label: false }, { narration: "Working through the plan.", plan }),
  ).toBe("Working through the plan.\n\n• Exec\n✅ Inspect\n▸ Patch\n▢ Verify");
});

it("uses only a summary when the checklist has one line available", () => {
  expect(formatChecklist(plan, { maxLines: 1, maxLineChars: 80 })).toEqual(["✅ 1/3 done"]);
});

it("keeps the active step when later pending work fills the checklist", () => {
  expect(
    formatChecklist(
      [
        { step: "Done", status: "completed" },
        { step: "Active", status: "in_progress" },
        { step: "Next", status: "pending" },
        { step: "Later", status: "pending" },
        { step: "Last", status: "pending" },
      ],
      { maxLines: 3, maxLineChars: 80 },
    ),
  ).toEqual(["✅ 1/5 done", "▸ Active", "▢ Last"]);
});

it("drops every tool line when the checklist consumes the whole budget", () => {
  expect(
    draftText(
      ["tool one", "tool two"],
      { label: false, maxLines: 2 },
      {
        plan: [
          { step: "Active", status: "in_progress" },
          { step: "Next", status: "pending" },
        ],
      },
    ),
  ).toBe("▸ Active\n▢ Next");
});

it("honors the caller's mode when resolving commentary", () => {
  const entry = { streaming: { progress: { commentary: true } } };
  expect(resolveChannelStreamingProgressCommentary(entry, false, "progress")).toBe(true);
  expect(resolveChannelStreamingProgressCommentary(entry, false, "partial")).toBe(false);
  expect(
    resolveChannelStreamingProgressCommentary(
      { streaming: { mode: "progress", progress: { commentary: true } } },
      false,
    ),
  ).toBe(true);
});

it("resolves the narration toggle with default on", () => {
  expect(resolveChannelStreamingProgressNarration(undefined)).toBe(true);
  expect(resolveChannelStreamingProgressNarration({ streaming: { mode: "progress" } })).toBe(true);
  expect(
    resolveChannelStreamingProgressNarration({
      streaming: { mode: "progress", progress: { narration: false } },
    }),
  ).toBe(false);
});
type CommandInput = Extract<
  ChannelProgressDraftLineInput,
  { event: "tool" | "item" | "command-output" }
>;
const commandItem = { event: "item" as const, itemId: "command:call-1", itemKind: "command" };
const commandOutput = { event: "command-output" as const, itemId: "command:call-1", phase: "end" };

function buildLine(input: CommandInput, markdown = false) {
  const line = buildChannelProgressDraftLine(
    { toolCallId: "call-1", name: "exec", ...input },
    { commandText: "raw", markdown },
  );
  if (!line) {
    throw new Error("expected command progress");
  }
  return line;
}

// Preserve the producer's order: terminal items precede the titled command output.
function commandSequence(): CommandInput[] {
  const status = "failed";
  const item = { event: "item" as const, meta: "run tests · pty · elevated" };
  const tool = {
    ...item,
    itemId: "tool:call-1",
    itemKind: "tool",
    title: `exec ${item.meta}`,
    commandBearing: true,
  };
  const command = {
    ...item,
    itemId: "command:call-1",
    itemKind: "command",
    title: `command ${item.meta}`,
  };
  const output = { event: "command-output" as const, phase: "end", status, exitCode: 1 };
  return [
    { event: "tool", itemId: tool.itemId, phase: "start", args: { command: "pnpm test" } },
    { ...tool, phase: "start", status: "running" },
    { ...command, phase: "start", status: "running" },
    output,
    { ...tool, phase: "end", status },
    { ...command, phase: "end", status, summary: "3 tests failed" },
    { ...output, itemId: command.itemId, title: command.title },
  ];
}

it("keeps one command row through failed terminal delivery", async () => {
  const commandText = "`run tests`";
  const detail = `pty · elevated · ${commandText}`;
  let rendered = "";
  const progress = createChannelProgressDraftCompositor({
    active: true,
    mode: "progress",
    seed: "command-correlation",
    entry: { streaming: { progress: { label: false, toolProgress: true, maxLines: 4 } } },
    update: (text) => {
      rendered = text;
      return true;
    },
  });
  try {
    const inputs = commandSequence();
    for (const [index, input] of inputs.entries()) {
      await progress.pushToolProgress(buildLine(input, true));
      const lines = progress.getSnapshot().lines;
      expect(lines, `event ${index}`).toHaveLength(1);
      expect(lines[0], `event ${index}`).toMatchObject({
        id: "tool:call-1",
        detail: index === 0 ? commandText : detail,
      });
    }
    await progress.start();
    expect(progress.getSnapshot().lines[0]).toMatchObject({
      kind: "command-output",
      detail,
      status: "exit 1",
      text: `exit 1; ${detail}`,
    });
    expect(rendered.match(/run tests/g)).toHaveLength(1);
  } finally {
    progress.cancel();
  }
});

it("keeps a flagged output title when it describes different work", () => {
  const previous = buildLine({
    ...commandItem,
    status: "running",
    meta: "inspect files · pty",
  });
  const output = buildLine({
    ...commandOutput,
    title: "command run tests · pty",
    exitCode: 0,
  });
  expect(mergeLine([previous], output, { maxLines: 4 })[0]?.detail).toBe("pty · command run tests");
  expect(mergeLine([], output, { maxLines: 4 })[0]?.detail).toBe("pty · command run tests");
});

it("replaces a terminal failure when recovered output names no command", () => {
  const endedLine = buildLine({
    ...commandItem,
    phase: "end",
    status: "failed",
    progressText: "install dependencies failed",
  });
  const recoveredOutput = buildLine({ ...commandOutput, exitCode: 0 });
  expect(endedLine.detail).toBe("install dependencies failed");
  const merged = mergeLine([endedLine], recoveredOutput, { maxLines: 4 });
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ kind: "command-output", status: "completed" });
  expect(merged[0]).not.toHaveProperty("detail");
});

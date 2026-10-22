import { afterEach, expect, it, vi } from "vitest";
import { inferToolMetaFromArgsCore } from "../agents/tool-display.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import {
  type AgentPlanStep,
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
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine,
  isChannelProgressDraftWorkToolName,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingPreviewChunk,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  resolveChannelStreamingPreviewToolProgress,
} from "./streaming.js";

const inheritedBlock = (mode: string) =>
  resolveChannelStreamingBlockEnabled(
    { streaming: { mode } },
    { previewAvailable: true, blockStreamingDefault: "on" },
  );
const rawCommandEntry = { streaming: { progress: { commandText: "raw" } } };
const step = (text: string, status: AgentPlanStep["status"] = "pending"): AgentPlanStep => ({
  step: text,
  status,
});
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

const plan = [step("Inspect", "completed"), step("Patch", "in_progress"), step("Verify")];

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
  expect(
    draftText(["Exec"], { label: false }, { narration: "Working through the plan.", plan }),
  ).toBe("Working through the plan.\n\n• Exec\n✅ Inspect\n▸ Patch\n▢ Verify");
});

it.each([
  { maxLines: 1, steps: plan, expected: ["✅ 1/3 done"] },
  {
    maxLines: 3,
    steps: [
      step("Done", "completed"),
      step("Active", "in_progress"),
      ...["Next", "Later", "Last"].map((name) => step(name)),
    ],
    expected: ["✅ 1/5 done", "▸ Active", "▢ Last"],
  },
])(
  "keeps the summary and active step within $maxLines checklist lines",
  ({ maxLines, steps, expected }) => {
    expect(formatChecklist(steps, { maxLines, maxLineChars: 80 })).toEqual(expected);
  },
);

it("drops every tool line when the checklist consumes the whole budget", () => {
  expect(
    draftText(
      ["tool one", "tool two"],
      { label: false, maxLines: 2 },
      { plan: [step("Active", "in_progress"), step("Next")] },
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

const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1_500;
const progressEntry = (progress: ChannelStreamingProgressConfig) => ({ streaming: { progress } });
const render: typeof draftText = (lines, progress, options) =>
  formatText({ entry: progressEntry(progress), lines, ...options });
const commentary = (text: string) => ({
  kind: "item" as const,
  text,
  label: "Commentary",
  prefix: false,
});

afterEach(() => {
  vi.useRealTimers();
});

it("reads canonical nested streaming config", () => {
  const entry = {
    streaming: {
      chunkMode: "newline",
      nativeTransport: true,
      block: {
        enabled: true,
        coalesce: { minChars: 40, maxChars: 80, idleMs: 250 },
      },
      preview: {
        chunk: { minChars: 10, maxChars: 20, breakPreference: "sentence" },
        toolProgress: false,
        commandText: "status",
      },
    },
  } as const;

  expect({
    mode: resolveChannelStreamingChunkMode(entry),
    native: resolveChannelStreamingNativeTransport(entry),
    block: resolveChannelStreamingBlockEnabled(entry, {
      previewAvailable: true,
      blockStreamingDefault: "off",
    }),
    coalesce: resolveChannelStreamingBlockCoalesce(entry),
    chunk: resolveChannelStreamingPreviewChunk(entry),
    toolProgress: resolveChannelStreamingPreviewToolProgress(entry),
    commandText: resolveChannelStreamingPreviewCommandText(entry),
  }).toEqual({
    mode: "newline",
    native: true,
    block: true,
    coalesce: { minChars: 40, maxChars: 80, idleMs: 250 },
    chunk: { minChars: 10, maxChars: 20, breakPreference: "sentence" },
    toolProgress: false,
    commandText: "status",
  });
});

it.each([
  ["partial", undefined, true],
  ["block", { toolProgress: true }, true],
  ["progress", { toolProgress: true }, false],
])("keeps progress-only configuration scoped to progress mode: %s", (mode, preview, expected) => {
  expect(
    resolveChannelStreamingPreviewToolProgress({
      streaming: { mode, preview, progress: { toolProgress: false } },
    }),
  ).toBe(expected);
});

it("suppresses standalone tool progress for active preview drafts", () => {
  const suppress = resolveChannelStreamingSuppressDefaultToolProgressMessages;
  const partial = { streaming: { mode: "partial", preview: { toolProgress: false } } };
  const progress = { streaming: { mode: "progress", progress: { toolProgress: false } } };
  expect(suppress(progress)).toBe(true);
  expect(suppress(partial, { draftStreamActive: true })).toBe(true);
  expect(suppress({ streaming: { mode: "progress" } }, { draftStreamActive: false })).toBe(false);
});

it("renders automatic and configured progress labels through the public formatter", () => {
  expect(formatText({ lines: [], random: () => 0 })).toBe("Working");
  expect(render([], { label: " AUTO " }, { random: () => 0 })).toBe("Working");
  const options = { narration: "Counting files.", random: () => 0.5 };
  expect(render([], { label: "auto", labels: ["Pearling"] }, options)).toBe(
    "Pearling\n\nCounting files.",
  );
});

it("formats bounded progress draft text", () => {
  const patch = buildChannelProgressDraftLine({
    event: "patch",
    summary: "1 modified",
    modified: ["/tmp/demo/index.html"],
  });
  if (!patch) {
    throw new Error("expected patch progress");
  }
  const entry = progressEntry({ label: "Shelling", maxLines: 2, maxLineChars: 80 });
  expect(
    formatText({
      entry,
      lines: [" tool: read ", "patch applied", "tests done"],
      formatLine: (line) => `\`${line}\``,
    }),
  ).toBe("• `patch applied`\n• `tests done`");
  expect(formatText({ entry, lines: [patch, "plain update"] })).toBe(
    "• 1 modified; /tmp/demo/index.html\n• plain update",
  );
  expect(render([commentary("_Checking source data before summarizing._")], { label: false })).toBe(
    "_Checking source data before summarizing._",
  );
});

it("falls back to plain commentary when compaction drops the closing italic marker", () => {
  expect(render([commentary(`_${"x".repeat(80)}_`)], { label: false, maxLineChars: 32 })).toBe(
    `${"x".repeat(30)}…`,
  );
});

it("keeps compacted raw progress lines from leaking unmatched markdown backticks", () => {
  const line = buildChannelProgressDraftLine(
    {
      event: "tool",
      name: "exec",
      args: {
        command: `node scripts/check-${"long-".repeat(8)}path /tmp/${"deep/".repeat(20)}index.ts --flag value`,
      },
    },
    { detailMode: "raw", commandText: "raw" },
  );

  const text = formatText({
    entry: progressEntry({ label: "Shelling" }),
    lines: line ? [line] : [],
  });

  expect(text).toMatch(/^Shelling\n\n• run node script/u);
  expect(text).toContain("…");
  expect(text).toMatch(/index\.ts --flag value$/u);
  expect(text.match(/`/g) ?? []).toHaveLength(0);
});

it("hides empty reasoning but renders reasoning text", () => {
  const input = { event: "item", itemKind: "analysis", title: "Reasoning" } as const;
  expect(formatChannelProgressDraftLine(input)).toBeUndefined();
  expect(formatChannelProgressDraftLine({ ...input, progressText: "Reading the code path" })).toBe(
    "Reading the code path",
  );
});

it("updates keyed progress lines in place", () => {
  const input = {
    event: "item",
    itemId: "preamble-1",
    itemKind: "preamble",
    title: "Preamble",
  } as const;
  const first = buildChannelProgressDraftLine({ ...input, progressText: "Checking" });
  const second = buildChannelProgressDraftLine({ ...input, progressText: "Checking stream" });
  if (!first || !second) {
    throw new Error("expected preamble progress lines");
  }

  const lines = mergeLine<string | NonNullable<typeof first>>(["Exec"], first, { maxLines: 4 });
  const updated = mergeLine(lines, second, { maxLines: 4 });

  expect(updated).toMatchObject(["Exec", { id: "preamble-1", text: "Checking stream" }]);
  expect(render(updated, { label: false })).toBe("• Exec\n• Checking stream");
});

it("delays rapid work events and joins a single pending startup", async () => {
  vi.useFakeTimers();
  const pending = createDeferredCore();
  const onStart = vi.fn(() => pending.promise);
  const gate = createChannelProgressDraftGate({ onStart });

  await expect(gate.noteWork()).resolves.toBe(false);
  await expect(gate.noteWork()).resolves.toBe(false);

  expect(gate.workEvents).toBe(2);
  expect(onStart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS - 1);
  expect(onStart).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(gate.hasStarted).toBe(true);
  const explicitStart = gate.startNow();
  let workSettled = false;
  const workDuringStart = gate.noteWork().then((started) => {
    workSettled = true;
    return started;
  });
  await Promise.resolve();
  expect(workSettled).toBe(false);
  expect(onStart).toHaveBeenCalledTimes(1);
  pending.resolve();
  await expect(explicitStart).resolves.toBeUndefined();
  await expect(workDuringStart).resolves.toBe(true);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(gate.hasStarted).toBe(true);
});

it("does not report started when delayed progress startup rejects", async () => {
  vi.useFakeTimers();
  const error = new Error("draft unavailable");
  const onStart = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(undefined);
  const onStartError = vi.fn();
  const gate = createChannelProgressDraftGate({ onStart, onStartError });

  await expect(gate.noteWork()).resolves.toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(onStart).toHaveBeenCalledTimes(1);
  expect(gate.hasStarted).toBe(false);
  expect(onStartError).toHaveBeenCalledWith(error);

  await expect(gate.startNow()).resolves.toBeUndefined();

  expect(onStart).toHaveBeenCalledTimes(2);
  expect(gate.hasStarted).toBe(true);
});

it("does not report active when cancel wins the startup race", async () => {
  vi.useFakeTimers();
  const pending = createDeferredCore();
  const onStart = vi.fn(() => pending.promise);
  const gate = createChannelProgressDraftGate({ onStart });

  await gate.noteWork();
  const startResult = gate.startNow();
  await Promise.resolve();

  expect(onStart).toHaveBeenCalledTimes(1);
  gate.cancel();

  pending.resolve();

  await expect(startResult).resolves.toBeUndefined();
  expect(gate.hasStarted).toBe(false);
});

it("ignores message-like tools for progress draft work", () => {
  expect(
    ["message", "react", "web_search", "exec"].map(isChannelProgressDraftWorkToolName),
  ).toEqual([false, false, true, true]);
});

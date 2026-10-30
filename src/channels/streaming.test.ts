import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import {
  type AgentPlanStep,
  type ChannelProgressDraftLineInput,
  type ChannelStreamingProgressConfig,
  buildChannelProgressDraftLine as buildLineInput,
  buildChannelProgressDraftLineForEntry as buildForEntry,
  formatChannelProgressDraftLineForEntry as formatForEntry,
  formatChannelProgressDraftText as formatText,
  formatPlanChecklistLines as formatChecklist,
  normalizeAgentPlanSteps,
  mergeChannelProgressDraftLine as mergeLine,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingProgressCommentary as readCommentary,
  resolveChannelStreamingProgressNarration as readNarration,
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine as formatLine,
  isChannelProgressDraftWorkToolName,
  resolveChannelStreamingBlockCoalesce as readCoalesce,
  resolveChannelStreamingChunkMode as readChunkMode,
  resolveChannelStreamingNativeTransport as readNative,
  resolveChannelStreamingPreviewCommandText as readCommand,
  resolveChannelStreamingPreviewChunk as readChunk,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  resolveChannelStreamingPreviewToolProgress as readTools,
} from "./streaming.js";

const inheritedBlock = (mode: string) =>
  resolveChannelStreamingBlockEnabled(
    { streaming: { mode } },
    { previewAvailable: true, blockStreamingDefault: "on" },
  );
const rawCommandEntry = { streaming: { progress: { commandText: "raw" } } };
type ItemInput = Extract<ChannelProgressDraftLineInput, { event: "item" }>;
const item = (overrides: Omit<ItemInput, "event">): ItemInput => ({ event: "item", ...overrides });
const toolInput = (
  name: string,
  args: Record<string, unknown>,
): Extract<ChannelProgressDraftLineInput, { event: "tool" }> => ({
  event: "tool",
  name,
  args,
});
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
  const input = item({
    name: "process",
    title: "Check",
    progressText: "job",
  });
  const running = formatForEntry(undefined, { ...input, status: "running" });
  const failed = formatForEntry(undefined, { ...input, status: "failed" });
  expect(running).toContain("Check");
  expect(failed).toContain("Check");
  expect(failed).toContain("failed");
  expect(failed).toContain("job");
  expect(failed).not.toBe(running);
});

it("bounds prepared path titles at the configured maxLineChars", () => {
  const maxLineChars = 40;
  const path = `/tmp/${"deep/".repeat(40)}file.txt`;
  const entry = { streaming: { progress: { maxLineChars } } };
  const input = item({ name: "read", title: path, meta: path, status: "failed" });
  const line = buildForEntry(entry, input, { toolIcons: true });

  expect(line?.label).toContain("…");
  expect(line?.label).toMatch(/file\.txt$/);
  expect(line?.text).toContain("failed");
  expect(Array.from(line!.text).length).toBeLessThanOrEqual(maxLineChars);
});

it("keeps plan arguments out of generic tool and item rows", () => {
  const name = "progress_card";
  const args = {
    markdown: '<progress aria-label="CI · 2/3" value="2" max="3"></progress>',
    plan: [{ step: "Inspect", status: "in_progress" }],
  };
  expect(buildLineInput(toolInput(name, args))).toBeUndefined();
  expect(buildLineInput(item({ itemKind: "tool", name, meta: args.markdown }))).toBeUndefined();
  expect(
    ["message", "react", "web_search", "exec"].map(isChannelProgressDraftWorkToolName),
  ).toEqual([false, false, true, true]);
});

it("keeps blocked plan-tool attention without raw argument metadata", () => {
  const input = item({ itemId: "plan", name: "progress_card", status: "blocked", meta: "private" });
  expect(buildLineInput(input)).toMatchObject({
    id: "plan",
    status: "blocked",
    text: "Progress Card",
  });
});

it("defaults entry-backed command progress to status and preserves explicit raw text", () => {
  const input = { ...toolInput("exec", { command: "echo private" }), phase: "start" };

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
    { event: "command-output", name: "exec", phase: "end", title: "echo private", exitCode: 1 },
    "exit 1",
  ],
  [
    item({
      itemKind: "command",
      name: "exec",
      phase: "start",
      status: "running",
      meta: "echo private",
    }),
    "Exec",
  ],
])("hides command text unless raw output is requested: %j", (input, statusText) => {
  expect(buildLineInput(input)?.text).toBe(statusText);
  expect(buildLineInput(input, { commandText: "raw" })?.text).toContain("echo private");
});
it("renders capitalized shell tools and their summary as one line", () => {
  const name = "Bash";
  const args = { command: "echo alpha", description: "print text" };
  const input = { ...toolInput(name, args), toolCallId: "call-1", phase: "start" };
  const structured = buildLineInput(input, { commandText: "raw" });
  const merged = mergeLine(
    structured ? [structured] : [],
    { kind: "item", label: "", text: "`print text`", prefix: false },
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
  ).toEqual([step("Inspect"), step("Patch", "in_progress")]);
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

it.each([
  {
    lines: ["Exec"],
    progress: { label: false as const },
    options: { narration: "Working.", plan },
    expected: "Working.\n\n• Exec\n✅ Inspect\n▸ Patch\n▢ Verify",
  },
  {
    lines: ["tool one", "tool two"],
    progress: { label: false as const, maxLines: 2 },
    options: { plan: [step("Active", "in_progress"), step("Next")] },
    expected: "▸ Active\n▢ Next",
  },
])(
  "renders the plan within the draft budget: $expected",
  ({ lines, progress, options, expected }) => {
    expect(draftText(lines, progress, options)).toBe(expected);
  },
);

it("honors the caller's mode when resolving commentary", () => {
  const entry = { streaming: { progress: { commentary: true } } };
  expect(readCommentary(entry, false, "progress")).toBe(true);
  expect(readCommentary(entry, false, "partial")).toBe(false);
  expect(readCommentary({ streaming: { ...entry.streaming, mode: "progress" } }, false)).toBe(true);
});

it("resolves the narration toggle with default on", () => {
  expect(readNarration(undefined)).toBe(true);
  expect(readNarration({ streaming: { mode: "progress" } })).toBe(true);
  expect(readNarration({ streaming: { progress: { narration: false } } })).toBe(false);
});
type CommandInput = Extract<
  ChannelProgressDraftLineInput,
  { event: "tool" | "item" | "command-output" }
>;
const commandItem = { event: "item" as const, itemId: "command:call-1", itemKind: "command" };
const commandOutput = { event: "command-output" as const, itemId: "command:call-1", phase: "end" };

function buildLine(input: CommandInput, markdown = false) {
  const line = buildLineInput(
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
  const family = (kind: string, title: string) =>
    item({
      itemId: `${kind}:call-1`,
      itemKind: kind,
      title,
      meta: "run tests · pty · elevated",
    });
  const tool = { ...family("tool", "exec run tests · pty · elevated"), commandBearing: true };
  const command = family("command", "command run tests · pty · elevated");
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
    expect(progress.getSnapshot().lines[0]).toMatchObject({ text: `exit 1; ${detail}` });
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

const coalesce = { minChars: 40, maxChars: 80, idleMs: 250 };
const chunk = { minChars: 10, maxChars: 20, breakPreference: "sentence" } as const;
const readBlock = (entry: Parameters<typeof resolveChannelStreamingBlockEnabled>[0]) =>
  resolveChannelStreamingBlockEnabled(entry, {
    previewAvailable: true,
    blockStreamingDefault: "off",
  });
it.each([
  [readChunkMode, { chunkMode: "newline" }, "newline"],
  [readNative, { nativeTransport: true }, true],
  [readBlock, { block: { enabled: true } }, true],
  [readCoalesce, { block: { coalesce } }, { minChars: 40, maxChars: 80, idleMs: 250 }],
  [readChunk, { preview: { chunk } }, { minChars: 10, maxChars: 20, breakPreference: "sentence" }],
  [readTools, { preview: { toolProgress: false } }, false],
  [readCommand, { preview: { commandText: "status" } }, "status"],
] as const)("reads canonical nested streaming config with %s", (read, streaming, expected) => {
  expect(read({ streaming })).toEqual(expected);
});

it.each([
  ["partial", undefined, true],
  ["block", { toolProgress: true }, true],
  ["progress", { toolProgress: true }, false],
])("keeps progress-only configuration scoped to progress mode: %s", (mode, preview, expected) => {
  expect(
    readTools({
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

it.each([
  [`${"a".repeat(104)} important.json trailing text`, `${"a".repeat(104)} important.json…`],
  [`${"𠮷".repeat(40)} ${"x".repeat(100)}`, `${"𠮷".repeat(40)} ${"x".repeat(78)}…`],
])("preserves the code-point budget for a long progress label", (label, expected) => {
  expect(render([], { label })).toBe(expected);
});

it("formats bounded progress draft text", () => {
  const patch = buildLineInput({
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
  const line = buildLineInput(
    toolInput("exec", {
      command: `node scripts/check-${"long-".repeat(8)}path /tmp/${"deep/".repeat(20)}index.ts --flag value`,
    }),
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
  expect(formatLine(input)).toBeUndefined();
  expect(formatLine({ ...input, progressText: "Reading the code path" })).toBe(
    "Reading the code path",
  );
});

it("updates keyed progress lines in place", () => {
  const input = item({ itemId: "preamble-1", itemKind: "preamble", title: "Preamble" });
  const first = buildLineInput({ ...input, progressText: "Checking" });
  const second = buildLineInput({ ...input, progressText: "Checking stream" });
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
  const onStartError = vi.fn();
  const gate = createChannelProgressDraftGate({ onStart, onStartError });

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
  gate.reset();
  const error = new Error("draft unavailable");
  onStart.mockRejectedValueOnce(error);
  await expect(gate.noteWork()).resolves.toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(onStart).toHaveBeenCalledTimes(2);
  expect(gate.hasStarted).toBe(false);
  expect(onStartError).toHaveBeenCalledWith(error);

  await expect(gate.startNow()).resolves.toBeUndefined();

  expect(onStart).toHaveBeenCalledTimes(3);
  expect(gate.hasStarted).toBe(true);
});

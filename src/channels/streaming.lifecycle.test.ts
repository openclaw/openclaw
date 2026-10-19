import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  type ChannelStreamingProgressConfig,
  buildChannelProgressDraftLine,
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftText as formatText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine as mergeLine,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingPreviewChunk,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  resolveChannelStreamingPreviewToolProgress,
} from "./streaming.js";

const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1_500;
const progressEntry = (progress: ChannelStreamingProgressConfig) => ({ streaming: { progress } });
function render(
  lines: Parameters<typeof formatText>[0]["lines"],
  progress: ChannelStreamingProgressConfig,
  options: Omit<Parameters<typeof formatText>[0], "entry" | "lines"> = {},
) {
  return formatText({ lines, entry: progressEntry(progress), ...options });
}
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
  expect(
    suppress(partial, {
      draftStreamActive: true,
      previewToolProgressEnabled: true,
    }),
  ).toBe(true);
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
  expect({
    lines: resolveChannelProgressDraftMaxLines(entry),
    chars: resolveChannelProgressDraftMaxLineChars(entry),
  }).toEqual({ lines: 2, chars: 80 });
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

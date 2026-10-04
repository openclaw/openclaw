import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  buildChannelProgressDraftLine,
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
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

describe("channel-streaming", () => {
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

    expect(resolveChannelStreamingChunkMode(entry)).toBe("newline");
    expect(resolveChannelStreamingNativeTransport(entry)).toBe(true);
    expect(
      resolveChannelStreamingBlockEnabled(entry, {
        previewAvailable: true,
        blockStreamingDefault: "off",
      }),
    ).toBe(true);
    expect(resolveChannelStreamingBlockCoalesce(entry)).toEqual({
      minChars: 40,
      maxChars: 80,
      idleMs: 250,
    });
    expect(resolveChannelStreamingPreviewChunk(entry)).toEqual({
      minChars: 10,
      maxChars: 20,
      breakPreference: "sentence",
    });
    expect(resolveChannelStreamingPreviewToolProgress(entry)).toBe(false);
    expect(resolveChannelStreamingPreviewCommandText(entry)).toBe("status");
  });

  it("keeps progress-only tool progress config out of normal preview modes", () => {
    expect(
      resolveChannelStreamingPreviewToolProgress({
        streaming: { mode: "partial", progress: { toolProgress: false } },
      }),
    ).toBe(true);
    expect(
      resolveChannelStreamingPreviewToolProgress({
        streaming: {
          mode: "block",
          preview: { toolProgress: true },
          progress: { toolProgress: false },
        },
      }),
    ).toBe(true);
    expect(
      resolveChannelStreamingPreviewToolProgress({
        streaming: {
          mode: "progress",
          preview: { toolProgress: true },
          progress: { toolProgress: false },
        },
      }),
    ).toBe(false);
  });

  it("suppresses standalone tool progress for active preview drafts", () => {
    expect(
      resolveChannelStreamingSuppressDefaultToolProgressMessages({
        streaming: { mode: "progress", progress: { toolProgress: false } },
      }),
    ).toBe(true);
    expect(
      resolveChannelStreamingSuppressDefaultToolProgressMessages(
        { streaming: { mode: "partial", preview: { toolProgress: false } } },
        { draftStreamActive: true },
      ),
    ).toBe(true);
    expect(
      resolveChannelStreamingSuppressDefaultToolProgressMessages(
        { streaming: { mode: "partial", preview: { toolProgress: false } } },
        { draftStreamActive: true, previewToolProgressEnabled: true },
      ),
    ).toBe(true);
    expect(
      resolveChannelStreamingSuppressDefaultToolProgressMessages(
        { streaming: { mode: "progress" } },
        { draftStreamActive: false },
      ),
    ).toBe(false);
  });

  it("renders automatic and configured progress labels through the public formatter", () => {
    expect(formatChannelProgressDraftText({ lines: [], random: () => 0 })).toBe("Working");
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { progress: { label: " AUTO " } } },
        lines: [],
        random: () => 0,
      }),
    ).toBe("Working");
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { progress: { label: "auto", labels: ["Pearling"] } } },
        lines: [],
        narration: "Counting files.",
        random: () => 0.5,
      }),
    ).toBe("Pearling\n\nCounting files.");
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
    const entry = {
      streaming: { progress: { label: "Shelling", maxLines: 2, maxLineChars: 80 } },
    };
    expect(resolveChannelProgressDraftMaxLines(entry)).toBe(2);
    expect(resolveChannelProgressDraftMaxLineChars(entry)).toBe(80);
    expect(
      formatChannelProgressDraftText({
        entry,
        lines: [" tool: read ", "patch applied", "tests done"],
        formatLine: (line) => `\`${line}\``,
      }),
    ).toBe("• `patch applied`\n• `tests done`");
    expect(
      formatChannelProgressDraftText({
        entry,
        lines: [patch, "plain update"],
      }),
    ).toBe("🩹 1 modified; /tmp/demo/index.html\n• plain update");
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { progress: { label: false } } },
        lines: [
          {
            kind: "item",
            text: "_Checking source data before summarizing._",
            label: "Commentary",
            prefix: false,
          },
        ],
      }),
    ).toBe("_Checking source data before summarizing._");
  });

  it("falls back to plain commentary when compaction drops the closing italic marker", () => {
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { progress: { label: false, maxLineChars: 32 } } },
        lines: [
          {
            kind: "item",
            text: `_${"x".repeat(80)}_`,
            label: "Commentary",
            prefix: false,
          },
        ],
      }),
    ).toBe(`${"x".repeat(30)}…`);
  });

  it("keeps compacted raw progress lines from leaking unmatched markdown backticks", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        name: "exec",
        args: {
          command:
            "node scripts/check-something-with-a-very-long-path /tmp/openclaw/some/really/deep/path/that/keeps/going/and/going/index.ts --flag value",
        },
      },
      { detailMode: "raw", commandText: "raw" },
    );

    const text = formatChannelProgressDraftText({
      entry: { streaming: { progress: { label: "Shelling" } } },
      lines: line ? [line] : [],
    });

    expect(text).toBe(
      "Shelling\n\n🛠️ run node script…e…y/deep/path/that/keeps/going/and/going/index.ts --flag value",
    );
    expect(text.match(/`/g) ?? []).toHaveLength(0);
  });

  it("hides empty reasoning but renders reasoning text", () => {
    const input = { event: "item", itemKind: "analysis", title: "Reasoning" } as const;
    expect(formatChannelProgressDraftLine(input)).toBeUndefined();
    expect(
      formatChannelProgressDraftLine({ ...input, progressText: "Reading the code path" }),
    ).toBe("Reading the code path");
  });

  it("updates keyed progress lines in place", () => {
    const input = {
      event: "item",
      itemId: "preamble-1",
      itemKind: "preamble",
      title: "Preamble",
    } as const;
    const first = buildChannelProgressDraftLine({ ...input, progressText: "Checking the" });
    const second = buildChannelProgressDraftLine({
      ...input,
      progressText: "Checking the app-server stream",
    });
    if (!first || !second) {
      throw new Error("expected preamble progress lines");
    }

    const initialLines: Array<string | typeof first> = ["🛠️ Exec"];
    const lines = mergeChannelProgressDraftLine(initialLines, first, { maxLines: 4 });
    const updated = mergeChannelProgressDraftLine(lines, second, { maxLines: 4 });

    expect(updated).toHaveLength(2);
    expect(updated.at(-1)).toMatchObject({
      id: "preamble-1",
      text: "Checking the app-server stream",
    });
    expect(
      formatChannelProgressDraftText({
        lines: updated,
        entry: { streaming: { progress: { label: false } } },
      }),
    ).toBe("🛠️ Exec\n• Checking the app-server stream");
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
    expect(isChannelProgressDraftWorkToolName("message")).toBe(false);
    expect(isChannelProgressDraftWorkToolName("react")).toBe(false);
    expect(isChannelProgressDraftWorkToolName("web_search")).toBe(true);
    expect(isChannelProgressDraftWorkToolName("exec")).toBe(true);
  });
});

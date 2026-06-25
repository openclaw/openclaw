import { describe, expect, it } from "vitest";
import {
  buildChannelProgressDraftLine,
  resolveChannelStreamingProgressThinking,
} from "./streaming.js";

describe("resolveChannelStreamingProgressThinking", () => {
  // This resolver is the single source of truth for the Discord window-thinking
  // gate: it drives BOTH the compositor render gate and the subscriber opt-in
  // (streamReasoningInNonStreamModes). It must default OFF so no reasoning
  // side effects (status reaction, counters, render) leak when unconfigured.
  it("defaults to false when progress.thinking is unset", () => {
    expect(resolveChannelStreamingProgressThinking({ streaming: { mode: "progress" } })).toBe(
      false,
    );
  });

  it("is false when explicitly disabled", () => {
    expect(
      resolveChannelStreamingProgressThinking({
        streaming: { mode: "progress", progress: { thinking: false } },
      }),
    ).toBe(false);
  });

  it("is true only when explicitly enabled in progress mode", () => {
    expect(
      resolveChannelStreamingProgressThinking({
        streaming: { mode: "progress", progress: { thinking: true } },
      }),
    ).toBe(true);
  });

  it("stays false outside progress stream mode even when enabled", () => {
    expect(
      resolveChannelStreamingProgressThinking({
        streaming: { mode: "partial", progress: { thinking: true } },
      }),
    ).toBe(false);
  });

  it("defaults to false for a missing entry", () => {
    expect(resolveChannelStreamingProgressThinking(undefined)).toBe(false);
  });
});

describe("buildChannelProgressDraftLine", () => {
  it("omits generic completed status from successful command output with title", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "exec-1",
        phase: "end",
        title: "pwd",
        name: "exec",
        exitCode: 0,
      },
      { commandText: "raw" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      id: "exec-1",
      text: "🛠️ pwd",
      detail: "pwd",
      status: "completed",
    });
  });

  it("uses the tool label when successful command output has no title", () => {
    const line = buildChannelProgressDraftLine({
      event: "command-output",
      phase: "end",
      name: "exec",
      exitCode: 0,
    });

    expect(line).toMatchObject({
      kind: "command-output",
      text: "🛠️ Exec",
      status: "completed",
    });
    expect(line?.detail).toBeUndefined();
  });

  it("keeps command status and title in raw command progress lines", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        toolCallId: "exec-1",
        phase: "end",
        title: "command false",
        name: "exec",
        exitCode: 2,
      },
      { commandText: "raw" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      id: "exec-1",
      text: "🛠️ exit 2; command false",
      detail: "command false",
      status: "exit 2",
    });
  });

  it("keeps only command status in status-only progress lines", () => {
    const line = buildChannelProgressDraftLine(
      {
        event: "command-output",
        phase: "end",
        title: "command false",
        name: "exec",
        exitCode: 2,
      },
      { commandText: "status" },
    );

    expect(line).toMatchObject({
      kind: "command-output",
      text: "🛠️ exit 2",
      detail: "exit 2",
      status: "exit 2",
    });
    expect(line?.text).not.toContain("command false");
  });
});

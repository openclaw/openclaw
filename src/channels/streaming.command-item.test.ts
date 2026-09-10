import { describe, expect, it } from "vitest";
import {
  buildChannelProgressDraftLine,
  formatChannelProgressDraftText,
  mergeChannelProgressDraftLine,
  type ChannelProgressDraftLine,
} from "./streaming.js";

// The embedded exec producer describes one command through several events
// that all correlate to command:<toolCallId>: the tool start (with args), the
// tool and command items opening as running, a status-only command output
// projected from the tool result, the tool and command items ending with a
// terminal status (the command item carries the output as its summary), and
// finally the command_output event whose title is the item title
// ("command <meta>"). The line the reader watches must keep the command text
// through every step.
function buildEmbeddedExecSequence(params: {
  status: "failed" | "completed";
  exitCode: number;
}): Array<{ step: string; line: ChannelProgressDraftLine }> {
  const options = { commandText: "raw" as const };
  const build = (
    step: string,
    input: Parameters<typeof buildChannelProgressDraftLine>[0],
  ): { step: string; line: ChannelProgressDraftLine } => {
    const line = buildChannelProgressDraftLine(input, options);
    if (!line) {
      throw new Error(`expected a progress line for ${step}`);
    }
    return { step, line };
  };
  const common = { toolCallId: "call-1", name: "exec" };
  return [
    build("tool start", {
      event: "tool",
      ...common,
      itemId: "tool:call-1",
      phase: "start",
      args: { command: "pnpm test" },
    }),
    build("tool item start", {
      event: "item",
      ...common,
      itemId: "tool:call-1",
      itemKind: "tool",
      title: "exec run tests",
      phase: "start",
      status: "running",
      meta: "run tests",
      commandBearing: true,
    }),
    build("command item start", {
      event: "item",
      ...common,
      itemId: "command:call-1",
      itemKind: "command",
      title: "command run tests",
      phase: "start",
      status: "running",
      meta: "run tests",
    }),
    build("tool result output", {
      event: "command-output",
      ...common,
      phase: "end",
      status: params.status,
      exitCode: params.exitCode,
    }),
    build("tool item end", {
      event: "item",
      ...common,
      itemId: "tool:call-1",
      itemKind: "tool",
      title: "exec run tests",
      phase: "end",
      status: params.status,
      meta: "run tests",
      commandBearing: true,
    }),
    build("command item end", {
      event: "item",
      ...common,
      itemId: "command:call-1",
      itemKind: "command",
      title: "command run tests",
      phase: "end",
      status: params.status,
      meta: "run tests",
      summary: "3 tests failed",
    }),
    build("command output", {
      event: "command-output",
      ...common,
      itemId: "command:call-1",
      phase: "end",
      title: "command run tests",
      status: params.status,
      exitCode: params.exitCode,
    }),
  ];
}

describe("channel-streaming embedded command items", () => {
  it.each([
    { status: "failed" as const, exitCode: 1, finalStatus: "exit 1", text: "🛠️ exit 1; run tests" },
    { status: "completed" as const, exitCode: 0, finalStatus: "completed", text: "🛠️ run tests" },
  ])(
    "keeps the shown command detail through the terminal command item ($status)",
    ({ status, exitCode, finalStatus, text }) => {
      let lines: ChannelProgressDraftLine[] = [];
      for (const { step, line } of buildEmbeddedExecSequence({ status, exitCode })) {
        lines = mergeChannelProgressDraftLine(lines, line, { maxLines: 4 });
        expect(lines, step).toHaveLength(1);
        expect(lines[0]?.detail, step).toBe("run tests");
      }

      expect(lines[0]).toMatchObject({
        kind: "command-output",
        detail: "run tests",
        status: finalStatus,
        text,
      });
      expect(
        formatChannelProgressDraftText({
          lines,
          entry: { streaming: { progress: { label: false } } },
        }),
      ).toBe(text);
    },
  );

  it("still replaces an ended line whole when the output names no command", () => {
    // A recovered run reports its outcome without a title; the stale failure
    // text of the ended line must not survive as the recovered line's detail.
    const endedLine = buildChannelProgressDraftLine(
      {
        event: "item",
        itemId: "command:call-2",
        toolCallId: "call-2",
        itemKind: "command",
        name: "exec",
        phase: "end",
        status: "failed",
        progressText: "install dependencies failed",
      },
      { commandText: "raw" },
    );
    const recoveredOutput = buildChannelProgressDraftLine(
      {
        event: "command-output",
        itemId: "command:call-2",
        toolCallId: "call-2",
        name: "exec",
        phase: "end",
        exitCode: 0,
      },
      { commandText: "raw" },
    );
    if (!endedLine || !recoveredOutput) {
      throw new Error("expected recovered command progress lines");
    }
    expect(endedLine.detail).toBe("install dependencies failed");

    const merged = mergeChannelProgressDraftLine([endedLine], recoveredOutput, { maxLines: 4 });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "command-output", status: "completed" });
    expect(merged[0]).not.toHaveProperty("detail");
  });
});

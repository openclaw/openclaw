import { describe, expect, it } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import {
  buildChannelProgressDraftLine,
  mergeChannelProgressDraftLine,
  type ChannelProgressDraftLineInput,
} from "./streaming.js";

type CommandInput = Extract<
  ChannelProgressDraftLineInput,
  { event: "tool" | "item" | "command-output" }
>;

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
function commandSequence(status: "failed" | "completed", exitCode: number): CommandInput[] {
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
  const output = { event: "command-output" as const, phase: "end", status, exitCode };
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

describe("channel-streaming embedded command items", () => {
  it.each([
    { status: "failed", exitCode: 1, markdown: true, finalStatus: "exit 1" },
    { status: "completed", exitCode: 0, markdown: false, finalStatus: "completed" },
  ] as const)("keeps one command row through terminal delivery ($status)", async (params) => {
    const commandText = params.markdown ? "`run tests`" : "run tests";
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
      const inputs = commandSequence(params.status, params.exitCode);
      for (const [index, input] of inputs.entries()) {
        await progress.pushToolProgress(buildLine(input, params.markdown));
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
        status: params.finalStatus,
        text: `🛠️ ${params.exitCode === 0 ? "" : "exit 1; "}${detail}`,
      });
      expect(rendered.match(/run tests/g)).toHaveLength(1);
    } finally {
      progress.cancel();
    }
  });

  it("keeps a flagged output title when it describes different work", () => {
    const previous = buildLine({
      event: "item",
      itemId: "command:call-1",
      itemKind: "command",
      status: "running",
      meta: "inspect files · pty",
    });
    const output = buildLine({
      event: "command-output",
      itemId: "command:call-1",
      phase: "end",
      title: "command run tests · pty",
      exitCode: 0,
    });
    expect(mergeChannelProgressDraftLine([previous], output, { maxLines: 4 })[0]?.detail).toBe(
      "pty · command run tests",
    );
    expect(mergeChannelProgressDraftLine([], output, { maxLines: 4 })[0]?.detail).toBe(
      "pty · command run tests",
    );
  });

  it("replaces a terminal failure when recovered output names no command", () => {
    const endedLine = buildLine({
      event: "item",
      itemId: "command:call-1",
      itemKind: "command",
      phase: "end",
      status: "failed",
      progressText: "install dependencies failed",
    });
    const recoveredOutput = buildLine({
      event: "command-output",
      itemId: "command:call-1",
      phase: "end",
      exitCode: 0,
    });
    expect(endedLine.detail).toBe("install dependencies failed");
    const merged = mergeChannelProgressDraftLine([endedLine], recoveredOutput, { maxLines: 4 });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "command-output", status: "completed" });
    expect(merged[0]).not.toHaveProperty("detail");
  });
});

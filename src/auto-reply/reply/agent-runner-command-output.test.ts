import { describe, expect, it } from "vitest";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";

const BASH_ARGS = { command: "nope-not-a-command", description: "run missing binary" };

function buildFromCliResult(overrides: Record<string, unknown>) {
  return buildCommandOutputFromToolResultEvent({
    stream: "tool",
    data: { phase: "result", name: "Bash", toolCallId: "call-1", args: BASH_ARGS, ...overrides },
  });
}

describe("buildCommandOutputFromToolResultEvent", () => {
  it.each(["exec", "mcp__openclaw__exec", "mcp_openclaw_exec"])(
    "preserves the authored title and raw identity for %s",
    (name) => {
      expect(
        buildFromCliResult({
          name,
          commandBearing: true,
          args: { command: "false", title: "Check build status" },
          isError: true,
          result: "command failed",
        }),
      ).toMatchObject({
        name,
        toolCallId: "call-1",
        title: "Check build status",
        status: "failed",
        output: "command failed",
      });
    },
  );

  it.each([
    { name: "mcp__other__exec", commandBearing: true, title: undefined, expected: "false" },
    { name: "mcp__openclaw__exec", title: "Recorded title", expected: "Recorded title" },
  ])("keeps explicit titles and third-party names unchanged: $name", ({ expected, ...data }) => {
    expect(
      buildFromCliResult({
        commandBearing: true,
        args: { command: "false", title: "Check build status" },
        isError: true,
        result: "command failed",
        ...data,
      }),
    ).toMatchObject({ name: data.name, title: expected, status: "failed" });
  });

  it("reports a CLI command failure whose result is only text", () => {
    // CLI backends report the outcome plus raw content, never a structured
    // record, so requiring a structured field dropped the failure entirely.
    const built = buildFromCliResult({
      isError: true,
      result: "bash: nope-not-a-command: command not found",
    });

    expect(built?.status).toBe("failed");
    expect(built?.output).toBe("bash: nope-not-a-command: command not found");
    expect(built?.title).toContain("nope-not-a-command");
  });

  it("reads the outcome from streamed text blocks", () => {
    const built = buildFromCliResult({
      isError: true,
      result: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });

    expect(built?.status).toBe("failed");
    expect(built?.output).toBe("line one\nline two");
  });

  it("projects a safe terminal state from a namespaced command-bearing result", () => {
    const built = buildCommandOutputFromToolResultEvent({
      stream: "tool",
      data: {
        phase: "result",
        name: "server.exec",
        toolCallId: "call-1",
        commandBearing: true,
        isError: false,
      },
    });

    expect(built).toMatchObject({
      name: "server.exec",
      status: "completed",
      toolCallId: "call-1",
    });
  });

  it("prefers an explicit status and structured fields when present", () => {
    const built = buildCommandOutputFromToolResultEvent({
      stream: "tool",
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "call-1",
        title: "false",
        isError: true,
        result: { exitCode: 2, output: "structured output", status: "exit 2" },
      },
    });

    expect(built).toMatchObject({
      status: "exit 2",
      exitCode: 2,
      output: "structured output",
      title: "false",
    });
  });

  it("ignores events that carry no outcome and no content", () => {
    expect(
      buildCommandOutputFromToolResultEvent({
        stream: "tool",
        data: { phase: "result", name: "Bash", toolCallId: "call-1" },
      }),
    ).toBeUndefined();
  });

  it("ignores non-command tools and non-result phases", () => {
    expect(
      buildCommandOutputFromToolResultEvent({
        stream: "tool",
        data: { phase: "result", name: "Read", toolCallId: "call-1", isError: true },
      }),
    ).toBeUndefined();
    expect(buildFromCliResult({ phase: "start", isError: true })).toBeUndefined();
  });
});

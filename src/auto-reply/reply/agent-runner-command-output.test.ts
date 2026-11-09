import { expect, it } from "vitest";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";

function buildResult(data: Record<string, unknown>) {
  return buildCommandOutputFromToolResultEvent({
    stream: "tool",
    data: { phase: "result", name: "Bash", toolCallId: "call-1", ...data },
  });
}

const failedCommand = {
  commandBearing: true,
  args: { command: "false", title: "Check build status" },
  isError: true,
  result: "command failed",
};
it.each(["exec", "mcp__openclaw__exec", "mcp_openclaw_exec"])(
  "preserves the authored title and raw identity for %s",
  (name) => {
    expect(buildResult({ ...failedCommand, name })).toMatchObject({
      name,
      toolCallId: "call-1",
      title: "Check build status",
      status: "failed",
      output: "command failed",
    });
  },
);
it.each([
  { name: "mcp__other__exec", title: undefined, expected: "false" },
  { name: "mcp__openclaw__exec", title: "Recorded title", expected: "Recorded title" },
])("keeps explicit titles and third-party names unchanged: $name", ({ expected, ...data }) => {
  expect(buildResult({ ...failedCommand, ...data })).toMatchObject({
    name: data.name,
    title: expected,
    status: "failed",
  });
});

// CLI failures arrive as raw text or streamed blocks, not structured records.
it.each([
  {
    result: "bash: nope-not-a-command: command not found",
    output: "bash: nope-not-a-command: command not found",
  },
  {
    result: [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ],
    output: "line one\nline two",
  },
])("reads failed CLI output: $output", ({ result, output }) => {
  expect(
    buildResult({
      isError: true,
      result,
      args: { command: "nope-not-a-command", description: "run missing binary" },
    }),
  ).toMatchObject({
    status: "failed",
    output,
    title: expect.stringContaining("nope-not-a-command"),
  });
});
it("projects a safe terminal state from a namespaced command-bearing result", () => {
  expect(buildResult({ name: "server.exec", commandBearing: true, isError: false })).toMatchObject({
    name: "server.exec",
    status: "completed",
    toolCallId: "call-1",
  });
});
it("prefers an explicit status and structured fields when present", () => {
  expect(
    buildResult({
      name: "exec",
      title: "false",
      isError: true,
      result: { exitCode: 2, output: "structured output", status: "exit 2" },
    }),
  ).toMatchObject({ status: "exit 2", exitCode: 2, output: "structured output", title: "false" });
});
it.each([{}, { name: "Read", isError: true }, { phase: "start", isError: true }])(
  "ignores events without command outcomes: %j",
  (data) => expect(buildResult(data)).toBeUndefined(),
);

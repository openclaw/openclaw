import { expect, it, vi } from "vitest";
import type { GetReplyOptions } from "../types.js";
import {
  createRunResult,
  createMinimalRunAgentTurnParams,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
} from "./agent-runner-execution.test-support.js";
import type { EmbeddedAgentParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

function mockEvents(
  ...events: Array<Parameters<NonNullable<EmbeddedAgentParams["onAgentEvent"]>>[0]>
) {
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    for (const event of events) {
      await params.onAgentEvent?.(structuredClone(event));
    }
    return createRunResult("final");
  });
}

async function execute(opts: GetReplyOptions) {
  return (await getExecuteAgentTurnForTest())({
    ...createMinimalRunAgentTurnParams({ opts }),
    commandBody: "hello",
  });
}

function modelWait(phase: "update" | "end", progressText?: string) {
  return {
    itemId: "model-wait",
    kind: "model-wait",
    suppressDurableProgress: true,
    phase,
    ...(progressText === undefined ? {} : { progressText }),
  };
}

it("forwards plan, approval, command output, and patch events", async () => {
  const onPlanUpdate = vi.fn();
  const onApprovalEvent = vi.fn();
  const onCommandOutput = vi.fn();
  const onPatchSummary = vi.fn();
  const steps = [
    { step: "Inspect code", status: "completed" },
    { step: "Patch code", status: "in_progress" },
    { step: "Run tests", status: "pending" },
  ];
  const plan = {
    phase: "update",
    title: "Assistant proposed a plan",
    explanation: "Inspect code, patch it, run tests.",
  };
  const approval = {
    phase: "requested",
    kind: "exec",
    status: "pending",
    title: "Command approval requested",
    approvalId: "approval-1",
  };
  const command = {
    itemId: "command:exec-1",
    phase: "delta",
    title: "command ls",
    toolCallId: "exec-1",
    output: "README.md",
  };
  const patch = {
    itemId: "patch:patch-1",
    phase: "end",
    title: "apply patch",
    toolCallId: "patch-1",
    added: ["a.ts"],
    modified: ["b.ts"],
    deleted: [],
    summary: "1 added, 1 modified",
  };
  mockEvents(
    {
      stream: "plan",
      data: {
        ...plan,
        steps: [...steps, { step: "Malformed", status: "unknown" }, "legacy string"],
      },
    },
    { stream: "approval", data: approval },
    { stream: "command_output", data: command },
    { stream: "patch", data: patch },
  );

  await execute({ onPlanUpdate, onApprovalEvent, onCommandOutput, onPatchSummary });

  expect(onPlanUpdate).toHaveBeenCalledWith({
    ...plan,
    steps: [...steps, { step: "legacy string", status: "pending" }],
    source: undefined,
  });
  expect(onApprovalEvent).toHaveBeenCalledWith({
    ...approval,
    itemId: undefined,
    toolCallId: undefined,
    approvalSlug: undefined,
    command: undefined,
    host: undefined,
    reason: undefined,
    scope: undefined,
    message: undefined,
  });
  expect(onCommandOutput).toHaveBeenCalledWith({
    ...command,
    name: undefined,
    status: undefined,
    exitCode: undefined,
    durationMs: undefined,
    cwd: undefined,
  });
  expect(onPatchSummary).toHaveBeenCalledWith({
    ...patch,
    name: undefined,
  });
});

it("projects transient model waits and clears them across later model calls", async () => {
  const onItemEvent = vi.fn();
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    for (const data of [
      { phase: "waiting_for_model", reason: "response" },
      { phase: "waiting_for_model", reason: "slot" },
      { phase: "starting_model" },
      { phase: "waiting_for_model", reason: "response" },
      { phase: "starting_model" },
    ]) {
      await params.onAgentEvent?.({ stream: "run_status", data });
    }
    return createRunResult("final");
  });

  await execute({ onItemEvent });

  expect(onItemEvent.mock.calls.map(([payload]) => payload)).toEqual([
    modelWait("update", "Waiting for the local model to respond"),
    modelWait("update", "Waiting for a free model slot"),
    modelWait("end"),
    modelWait("update", "Waiting for the local model to respond"),
    modelWait("end"),
  ]);
});

it.each([
  {
    label: "completion",
    data: { status: "completed", result: { exitCode: 0, durationMs: 42 } },
    expected: {
      itemId: "command:exec-1",
      phase: "end",
      title: undefined,
      toolCallId: "exec-1",
      name: "exec",
      output: undefined,
      status: "completed",
      exitCode: 0,
      durationMs: 42,
      cwd: undefined,
    },
  },
  {
    label: "error",
    data: { isError: true, result: { content: [{ type: "text", text: "command failed" }] } },
    expected: expect.objectContaining({
      itemId: "command:exec-1",
      phase: "end",
      toolCallId: "exec-1",
      name: "exec",
      status: "failed",
    }),
  },
])("forwards Codex command tool $label as command output", async ({ data, expected }) => {
  const onCommandOutput = vi.fn();
  mockEvents({
    stream: "tool",
    data: {
      phase: "result",
      itemId: "command:exec-1",
      toolCallId: "exec-1",
      name: "exec",
      ...data,
    },
  });
  await execute({ onCommandOutput });
  expect(onCommandOutput).toHaveBeenCalledWith(expected);
});

it("does not synthesize command output from bare exec tool results", async () => {
  const onCommandOutput = vi.fn();
  mockEvents(
    {
      stream: "tool",
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "exec-1",
        isError: false,
      },
    },
    {
      stream: "command_output",
      data: {
        itemId: "command:exec-1",
        phase: "end",
        title: "command ls",
        toolCallId: "exec-1",
        name: "exec",
        status: "completed",
        exitCode: 0,
      },
    },
  );

  await execute({ onCommandOutput });

  expect(onCommandOutput).toHaveBeenCalledTimes(1);
  expect(onCommandOutput).toHaveBeenCalledWith(
    expect.objectContaining({
      itemId: "command:exec-1",
      phase: "end",
      status: "completed",
    }),
  );
});

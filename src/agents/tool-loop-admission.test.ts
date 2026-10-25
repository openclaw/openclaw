import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../packages/agent-core/src/agent-loop.js";
import {
  config,
  makeAssistantMessage,
  reply,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import {
  type DiagnosticEventPayload,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import type { AssistantMessage } from "../llm/types.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
import {
  clearBatchAdmittedToolCallsForRun,
  consumeBatchAdmittedToolCall,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { createToolLoopBatchAdmission } from "./embedded-agent-runner/run/tool-loop-recovery.js";
import { admitSingleToolCallLoop, admitToolCallBatch } from "./tool-loop-admission.js";
import { recordToolCall, recordToolCallOutcome } from "./tool-loop-detection.js";

const ctx = {
  agentId: "main",
  sessionKey: "tool-loop-admission",
  sessionId: "session-1",
  runId: "run-1",
  loopDetection: { enabled: true },
} satisfies HookContext;

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    toolCall: { type: "toolCall" as const, id, name, arguments: args },
    args,
  };
}

function rejectedCall(id: string, name: string) {
  return {
    ...call(id, name),
    validationFailure: {
      content: [{ type: "text" as const, text: `Validation failed for tool "${name}"` }],
      details: {},
    },
  };
}

type Admission = Awaited<ReturnType<typeof admitToolCallBatch>>;
let state: ReturnType<typeof getDiagnosticSessionState>;
async function expectVeto(
  calls: Parameters<typeof admitToolCallBatch>[0],
  expected: Record<string, unknown> = {},
) {
  await expect(admitToolCallBatch(calls, ctx)).resolves.toMatchObject({
    intervention: {
      kind: "critical-tool-loop",
      toolCallId: calls.at(-1)?.toolCall.id,
      ...expected,
    },
  });
}
function commit(admission: Admission, ...calls: ReturnType<typeof call>[]) {
  admission.commitReadyCalls?.(
    calls.map(({ toolCall, args }) => ({ toolCallId: toolCall.id, args })),
  );
}
function recordOutcome(candidate: ReturnType<typeof call>, result: unknown) {
  recordToolCallOutcome(state, {
    toolName: candidate.toolCall.name,
    toolParams: candidate.args,
    toolCallId: candidate.toolCall.id,
    result,
    runId: ctx.runId,
  });
}
const pollResult = {
  content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
  details: { status: "running" },
};
const pollArgs = { action: "poll", sessionId: "process-1" };
function seedPolls(count: number, recordCalls = false) {
  for (let index = 0; index < count; index++) {
    const id = `prior-${index}`;
    if (recordCalls) {
      recordToolCall(state, "process", pollArgs, id, { runId: ctx.runId });
    }
    recordOutcome(call(id, "process", pollArgs), pollResult);
  }
}
const composedTurnCap = 40;
const execFailure = {
  content: [{ type: "text" as const, text: "Traceback: missing package" }],
  details: { status: "completed", exitCode: 1, aggregated: "Traceback: missing package" },
};

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** Drive the real agent loop with real batch admission and wrapped read/exec tools. */
async function runComposedLoop(runId: string, callsForTurn: (turn: number) => ToolCallContent[]) {
  const hookCtx = { ...ctx, runId };
  const readExecute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "unchanged" }],
    details: {},
  }));
  const execExecute = vi.fn(async (_toolCallId: string, _params: unknown) => execFailure);
  const tools = [
    { name: "read", parameters: Type.Object({ path: Type.String() }), execute: readExecute },
    { name: "exec", parameters: Type.Object({ command: Type.String() }), execute: execExecute },
  ].map((tool) =>
    wrapToolWithBeforeToolCallHook({ ...tool, label: tool.name, description: tool.name }, hookCtx),
  );
  let turns = 0;
  const streamFn = () => {
    turns += 1;
    const calls = turns <= composedTurnCap ? callsForTurn(turns) : [];
    return reply({
      ...makeAssistantMessage(calls.length > 0 ? calls : [{ type: "text", text: "done" }]),
      timestamp: turns,
    });
  };

  const messages = await runAgentLoop(
    [{ role: "user", content: "keep going", timestamp: 0 }],
    { systemPrompt: "", messages: [], tools },
    {
      ...config,
      beforeToolBatch: createToolLoopBatchAdmission(hookCtx),
    },
    () => {},
    undefined,
    streamFn,
  );
  return { messages, turns, execExecute };
}

function firstLoopBlock(messages: readonly { role: string; details?: unknown }[]) {
  return messages.find(
    (message) =>
      message.role === "toolResult" &&
      (message.details as { deniedReason?: string } | undefined)?.deniedReason === "tool-loop",
  );
}

function expectFinal(messages: readonly unknown[], text: unknown) {
  expect(messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text }],
  });
}

describe("whole-batch tool-loop admission", () => {
  let events: DiagnosticEventPayload[];
  let unsubscribe: () => void;
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    resetAdjustedParamsByToolCallIdForTests();
    state = getDiagnosticSessionState(ctx);
    events = [];
    unsubscribe = onDiagnosticEvent((event) => events.push(event));
  });
  afterEach(() => unsubscribe());

  it.each([undefined, { enabled: false }])(
    "admits existing loops without recording when detection is disabled (%j)",
    async (loopDetection) => {
      seedPolls(30);
      const candidate = call("next", "process", pollArgs);
      await expectVeto([candidate]);
      const history = [...(state.toolCallHistory ?? [])];
      const disabled = { ...ctx, loopDetection };
      await expect(admitToolCallBatch([candidate], disabled)).resolves.toEqual({});
      await expect(
        admitSingleToolCallLoop({ toolName: "process", params: pollArgs }, disabled),
      ).resolves.toBeUndefined();
      expect(state.toolCallHistory).toEqual(history);
    },
  );

  it("returns bucketed warnings before process reaches a critical loop", async () => {
    const result = { content: [{ type: "text", text: "unchanged" }], details: {} };
    for (let index = 0; index < 20; index += 1) {
      const candidate = call(`repeat-${index}`, "process", pollArgs);
      const admission = await admitToolCallBatch([candidate], ctx);
      expect(admission.intervention).toBeUndefined();
      expect(admission.warnings ?? []).toEqual(
        index === 10
          ? [{ kind: "tool-loop-warning", toolCallId: candidate.toolCall.id, count: index }]
          : [],
      );
      commit(admission, candidate);
      recordOutcome(candidate, result);
    }
    expect(
      events.filter((event) => event.type === "tool.loop" && event.action === "warn"),
    ).toMatchObject([{ count: 10, agentId: "main" }]);
    expect(state.toolCallHistory).toHaveLength(20);
    expect(new Set(state.toolCallHistory?.map((entry) => entry.resultHash)).size).toBe(1);
    await expectVeto([call("critical", "process", pollArgs)], {
      detector: "known_poll_no_progress",
      count: 20,
    });
  });

  it("records argument-validation failures at launch and escalates their repeats", async () => {
    const skipped = rejectedCall("skipped", "exec");
    const skippedAdmission = await admitToolCallBatch([skipped], ctx);
    skippedAdmission.releaseSkippedCalls?.([skipped.toolCall.id]);
    commit(skippedAdmission, skipped);
    // A released rejection is dropped, even if a stale launch commit follows.
    expect(state.toolCallHistory ?? []).toEqual([]);

    const warnings: unknown[] = [];
    for (let index = 0; index < 20; index += 1) {
      const candidate = rejectedCall(`invalid-${index}`, "exec");
      const admission = await admitToolCallBatch([candidate], ctx);
      expect(admission.intervention).toBeUndefined();
      warnings.push(...(admission.warnings ?? []));
      // Rejected calls never reach the tool wrapper, so admission reserves no marker.
      expect(consumeBatchAdmittedToolCall(candidate.toolCall.id, ctx.runId)).toBe(false);
      expect(state.toolCallHistory ?? []).toHaveLength(index);
      commit(admission, candidate);
    }
    expect(state.toolCallHistory).toHaveLength(20);
    expect(state.toolCallHistory?.at(-1)).toMatchObject({
      toolCallId: "invalid-19",
      outcomeKind: "argument-validation",
      resultHash: expect.any(String),
    });
    expect(warnings).toEqual([{ kind: "tool-loop-warning", toolCallId: "invalid-10", count: 10 }]);
    await expectVeto([rejectedCall("critical", "exec")], {
      detector: "generic_repeat",
      count: 20,
    });
  });

  it("keeps a terminal exec failure streak across rejected exec calls", async () => {
    for (let index = 0; index < 20; index += 1) {
      const job = call(`job-${index}`, "exec", { command: `python job-${index}.py` });
      const batch = index % 4 === 0 ? [job, rejectedCall(`invalid-${index}`, "exec")] : [job];
      const admission = await admitToolCallBatch(batch, ctx);
      expect(admission.intervention).toBeUndefined();
      commit(admission, ...batch);
      recordOutcome(job, execFailure);
    }

    await expectVeto([call("next", "exec", { command: "python next.py" })], {
      detector: "generic_repeat",
      count: 20,
    });
  });

  it.each([
    { name: "mixed valid and rejected calls", mixed: true, blockedId: "read-11", executions: 0 },
    {
      name: "exec failures across rejected reads",
      mixed: false,
      blockedId: "exec-21",
      executions: 20,
    },
  ])("blocks $name through the agent loop", async ({ mixed, blockedId, executions }) => {
    const { messages, turns, execExecute } = await runComposedLoop("run-composed", (turn) =>
      mixed
        ? [
            call(`read-${turn}`, "read", { path: "a" }).toolCall,
            call(`exec-${turn}`, "exec").toolCall,
          ]
        : [
            call(`exec-${turn}`, "exec", { command: `python job-${turn}.py` }).toolCall,
            ...(turn % 4 === 0 ? [call(`read-${turn}`, "read").toolCall] : []),
          ],
    );
    expect(firstLoopBlock(messages)).toMatchObject({ toolCallId: blockedId });
    expect(execExecute).toHaveBeenCalledTimes(executions);
    expect(turns).toBeLessThan(composedTurnCap);
    expectFinal(messages, expect.stringContaining("tool-loop recovery"));
  });

  it("runs a corrected call before the repeated-error retry budget is exhausted", async () => {
    const { messages, execExecute } = await runComposedLoop("run-corrected", (turn) =>
      turn <= 2
        ? [call(`exec-${turn}`, "exec").toolCall]
        : turn === 3
          ? [call("exec-fixed", "exec", { command: "ls" }).toolCall]
          : [],
    );

    expect(firstLoopBlock(messages)).toBeUndefined();
    expect(execExecute).toHaveBeenCalledTimes(1);
    expect(execExecute.mock.calls[0]?.[1]).toEqual({ command: "ls" });
    expectFinal(messages, "done");
  });

  it.each([19, 20])("atomically vetoes a batch with %i prior polls", async (priorCount) => {
    seedPolls(priorCount, true);
    const crossing = priorCount === 19;
    const siblings = crossing
      ? [call("candidate-20", "process", pollArgs)]
      : Array.from({ length: 20 }, (_, index) => call(`safe-sibling-${index}`, "write"));
    const blockedId = crossing ? "candidate-21" : "repeated";
    const admission = await admitToolCallBatch(
      [...siblings, call(blockedId, "process", pollArgs)],
      ctx,
    );
    expect(admission).toMatchObject({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: blockedId,
        toolName: "process",
        detector: "known_poll_no_progress",
        count: 20,
      },
    });
    expect(state.toolCallHistory).toHaveLength(21);
    expect(state.toolCallHistory?.at(-1)).toMatchObject({
      toolName: "process",
      outcomeKind: "tool-loop-veto",
    });
    expect(consumeBatchAdmittedToolCall(siblings[0]!.toolCall.id, ctx.runId)).toBe(false);
    if (crossing) {
      await expectVeto([call("recovery-repeat", "process", pollArgs)], {
        detector: "known_poll_no_progress",
      });
    } else {
      await expect(
        admitToolCallBatch([call("recovery-write", "write")], ctx),
      ).resolves.toMatchObject({
        commitReadyCalls: expect.any(Function),
        releaseSkippedCalls: expect.any(Function),
      });
    }
  });

  it("records an admitted call once and skips only its duplicate single-call loop policy", async () => {
    const admitted = call("admitted", "read", { path: "/tmp/a" });

    const admission = await admitToolCallBatch([admitted], ctx);
    commit(admission, admitted);
    await expect(
      runBeforeToolCallHook({
        toolName: admitted.toolCall.name,
        params: admitted.args,
        toolCallId: admitted.toolCall.id,
        ctx,
      }),
    ).resolves.toMatchObject({ blocked: false });

    expect(state.toolCallHistory).toHaveLength(1);
    expect(consumeBatchAdmittedToolCall(admitted.toolCall.id, ctx.runId)).toBe(false);
  });

  it("cleans an admitted marker when a run ends before the wrapped tool consumes it", async () => {
    const admitted = call("blocked-later", "write");
    await admitToolCallBatch([admitted], ctx);

    clearBatchAdmittedToolCallsForRun(ctx.runId);

    expect(consumeBatchAdmittedToolCall(admitted.toolCall.id, ctx.runId)).toBe(false);
  });

  it("releases repeated skipped admissions without mutating bounded history", async () => {
    for (let index = 0; index < 30; index += 1) {
      recordToolCall(state, "read", { path: `/tmp/prior-${index}` }, `prior-${index}`);
    }
    const originalHistory = [...(state.toolCallHistory ?? [])];
    for (let index = 0; index < 25; index += 1) {
      const skipped = call(`skipped-${index}`, "write", { path: "/tmp/skipped" });
      const admission = await admitToolCallBatch([skipped], ctx);
      admission.releaseSkippedCalls?.([skipped.toolCall.id]);
      expect(consumeBatchAdmittedToolCall(skipped.toolCall.id, ctx.runId)).toBe(false);
    }
    expect(state.toolCallHistory).toEqual(originalHistory);
    expect(events).toEqual([]);
    const executed = call("executed", "write", { path: "/tmp/skipped" });
    const admission = await admitToolCallBatch([executed], ctx);
    commit(admission, executed);
    admission.releaseSkippedCalls?.([]);

    expect(state.toolCallHistory).toHaveLength(30);
    expect(state.toolCallHistory?.at(-1)).toMatchObject({
      runId: ctx.runId,
      toolCallId: executed.toolCall.id,
      toolName: executed.toolCall.name,
    });
    expect(consumeBatchAdmittedToolCall(executed.toolCall.id, ctx.runId)).toBe(true);
    expect(consumeBatchAdmittedToolCall(executed.toolCall.id, ctx.runId)).toBe(false);
  });

  it("commits ready siblings in assistant order and releases exact run markers", async () => {
    const otherRun = { ...ctx, runId: "run-2" };
    const sharedId = "shared-call";
    const first = call("first", "read", { path: "/tmp/first" });
    const skipped = call(sharedId, "write", { path: "/tmp/skipped" });
    const last = call("last", "read", { path: "/tmp/last" });
    const otherAdmission = await admitToolCallBatch(
      [call(sharedId, "read", { path: "/tmp/other" })],
      otherRun,
    );
    const admission = await admitToolCallBatch([first, skipped, last], ctx);

    commit(admission, last, first);
    admission.releaseSkippedCalls?.([skipped.toolCall.id]);

    expect(state.toolCallHistory?.slice(-2).map((record) => record.toolCallId)).toEqual([
      first.toolCall.id,
      last.toolCall.id,
    ]);
    expect(consumeBatchAdmittedToolCall(skipped.toolCall.id, ctx.runId)).toBe(false);
    expect(consumeBatchAdmittedToolCall(sharedId, otherRun.runId)).toBe(true);
    otherAdmission.releaseSkippedCalls?.([sharedId]);
  });
});

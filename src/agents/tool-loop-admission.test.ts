import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../packages/agent-core/src/agent-loop.js";
import type { StreamFn } from "../../packages/agent-core/src/types.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import type { AssistantMessage, Message } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
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
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";
import { admitToolCallBatch } from "./tool-loop-admission.js";
import { recordToolCall, recordToolCallOutcome } from "./tool-loop-detection.js";

const ctx = {
  agentId: "main",
  sessionKey: "tool-loop-admission",
  sessionId: "session-1",
  runId: "run-1",
  loopDetection: { enabled: true },
} satisfies HookContext;

function call(id: string, name: string, args: Record<string, unknown>) {
  return {
    toolCall: { type: "toolCall" as const, id, name, arguments: args },
    args,
  };
}

function rejectedCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    ...call(id, name, args),
    validationFailure: {
      content: [{ type: "text" as const, text: `Validation failed for tool "${name}"` }],
      details: {},
    },
  };
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
    wrapToolWithBeforeToolCallHook(
      {
        name: "read",
        label: "read",
        description: "read",
        parameters: Type.Object({ path: Type.String() }),
        execute: readExecute,
      },
      hookCtx,
    ),
    wrapToolWithBeforeToolCallHook(
      {
        name: "exec",
        label: "exec",
        description: "exec",
        parameters: Type.Object({ command: Type.String() }),
        execute: execExecute,
      },
      hookCtx,
    ),
  ];
  let turns = 0;
  const streamFn: StreamFn = () => {
    turns += 1;
    const calls = turns <= composedTurnCap ? callsForTurn(turns) : [];
    const message: AssistantMessage = {
      role: "assistant",
      content: calls.length > 0 ? calls : [{ type: "text", text: "done" }],
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage: createZeroUsageFixture(),
      stopReason: calls.length > 0 ? "toolUse" : "stop",
      timestamp: turns,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
    });
    return stream;
  };

  const messages = await runAgentLoop(
    [{ role: "user", content: "keep going", timestamp: 0 }],
    { systemPrompt: "", messages: [], tools },
    {
      model: {
        id: "faux-1",
        name: "Faux",
        api: "faux",
        provider: "faux",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 1_000,
      },
      convertToLlm: (entries) => entries as Message[],
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

function expectRecoveryStop(messages: readonly unknown[]) {
  expect(messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: expect.stringContaining("tool-loop recovery") }],
  });
}

describe("whole-batch tool-loop admission", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    resetAdjustedParamsByToolCallIdForTests();
  });

  it.each([
    ["read", { path: "/tmp/repeated" }, "generic_repeat"],
    ["process", { action: "poll", sessionId: "process-1" }, "known_poll_no_progress"],
  ] as const)(
    "returns bucketed warnings before %s reaches a critical loop",
    async (name, args, detector) => {
      const state = getDiagnosticSessionState(ctx);
      const warningCounts: number[] = [];
      const warningAgents: Array<string | undefined> = [];
      const unsubscribe = onDiagnosticEvent((event) => {
        if (event.type === "tool.loop" && event.action === "warn") {
          warningCounts.push(event.count);
          warningAgents.push(event.agentId);
        }
      });
      const result = { content: [{ type: "text", text: "unchanged" }], details: {} };
      try {
        for (let index = 0; index < 20; index += 1) {
          const candidate = call(`repeat-${index}`, name, args);
          const admission = await admitToolCallBatch([candidate], ctx);
          expect(admission.intervention).toBeUndefined();
          expect(admission.warnings ?? []).toEqual(
            index === 10
              ? [{ kind: "tool-loop-warning", toolCallId: candidate.toolCall.id, count: index }]
              : [],
          );
          admission.commitReadyCalls?.([{ toolCallId: candidate.toolCall.id, args }]);
          recordToolCallOutcome(state, {
            toolName: name,
            toolParams: args,
            toolCallId: candidate.toolCall.id,
            result,
            runId: ctx.runId,
          });
        }
        expect(warningCounts).toEqual([10]);
        expect(warningAgents).toEqual(["main"]);
        expect(state.toolCallHistory).toHaveLength(20);
        expect(new Set(state.toolCallHistory?.map((entry) => entry.resultHash)).size).toBe(1);
        await expect(
          admitToolCallBatch([call("critical", name, args)], ctx),
        ).resolves.toMatchObject({
          intervention: { kind: "critical-tool-loop", toolCallId: "critical", detector, count: 20 },
        });
      } finally {
        unsubscribe();
      }
    },
  );

  it("records argument-validation failures at launch and escalates their repeats", async () => {
    const state = getDiagnosticSessionState(ctx);
    const skipped = rejectedCall("skipped", "exec", {});
    const skippedAdmission = await admitToolCallBatch([skipped], ctx);
    skippedAdmission.releaseSkippedCalls?.([skipped.toolCall.id]);
    skippedAdmission.commitReadyCalls?.([{ toolCallId: skipped.toolCall.id, args: skipped.args }]);
    // A released rejection is dropped, even if a stale launch commit follows.
    expect(state.toolCallHistory ?? []).toEqual([]);

    const warnings: unknown[] = [];
    for (let index = 0; index < 20; index += 1) {
      const candidate = rejectedCall(`invalid-${index}`, "exec", {});
      const admission = await admitToolCallBatch([candidate], ctx);
      expect(admission.intervention).toBeUndefined();
      warnings.push(...(admission.warnings ?? []));
      // Rejected calls never reach the tool wrapper, so admission reserves no marker.
      expect(consumeBatchAdmittedToolCall(candidate.toolCall.id, ctx.runId)).toBe(false);
      expect(state.toolCallHistory ?? []).toHaveLength(index);
      admission.commitReadyCalls?.([{ toolCallId: candidate.toolCall.id, args: candidate.args }]);
    }
    expect(state.toolCallHistory).toHaveLength(20);
    expect(state.toolCallHistory?.at(-1)).toMatchObject({
      toolCallId: "invalid-19",
      outcomeKind: "argument-validation",
      resultHash: expect.any(String),
    });
    expect(warnings).toEqual([{ kind: "tool-loop-warning", toolCallId: "invalid-10", count: 10 }]);
    await expect(
      admitToolCallBatch([rejectedCall("critical", "exec", {})], ctx),
    ).resolves.toMatchObject({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: "critical",
        detector: "generic_repeat",
        count: 20,
      },
    });
  });

  it("keeps a terminal exec failure streak across rejected exec calls", async () => {
    const state = getDiagnosticSessionState(ctx);
    const failure = {
      content: [{ type: "text" as const, text: "Traceback: missing package" }],
      details: { status: "completed", exitCode: 1, aggregated: "Traceback: missing package" },
    };
    for (let index = 0; index < 20; index += 1) {
      const job = call(`job-${index}`, "exec", { command: `python job-${index}.py` });
      const batch = index % 4 === 0 ? [job, rejectedCall(`invalid-${index}`, "exec", {})] : [job];
      const admission = await admitToolCallBatch(batch, ctx);
      expect(admission.intervention).toBeUndefined();
      admission.commitReadyCalls?.(
        batch.map((entry) => ({ toolCallId: entry.toolCall.id, args: entry.args })),
      );
      recordToolCallOutcome(state, {
        toolName: "exec",
        toolParams: job.args,
        toolCallId: job.toolCall.id,
        result: failure,
        runId: ctx.runId,
      });
    }

    await expect(
      admitToolCallBatch([call("next", "exec", { command: "python next.py" })], ctx),
    ).resolves.toMatchObject({
      intervention: { toolCallId: "next", detector: "generic_repeat", count: 20 },
    });
  });

  it("blocks a repeated batch that mixes a valid call with a rejected one", async () => {
    const { messages, turns, execExecute } = await runComposedLoop("run-mixed", (turn) => [
      { type: "toolCall", id: `read-${turn}`, name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: `exec-${turn}`, name: "exec", arguments: {} },
    ]);

    // In assistant order the pair alternates, so ping-pong detection blocks it.
    expect(firstLoopBlock(messages)).toMatchObject({ toolCallId: "read-11" });
    expect(execExecute).not.toHaveBeenCalled();
    expect(turns).toBeLessThan(composedTurnCap);
    expectRecoveryStop(messages);
  });

  it("blocks changing exec failures across rejected calls to another tool", async () => {
    const { messages, turns, execExecute } = await runComposedLoop("run-exec-tail", (turn) => [
      {
        type: "toolCall",
        id: `exec-${turn}`,
        name: "exec",
        arguments: { command: `python job-${turn}.py` },
      },
      ...(turn % 4 === 0
        ? [{ type: "toolCall" as const, id: `read-${turn}`, name: "read", arguments: {} }]
        : []),
    ]);

    // Rejected reads never ran, so they must not end the exec failure tail.
    expect(firstLoopBlock(messages)).toMatchObject({ toolCallId: "exec-21" });
    expect(execExecute).toHaveBeenCalledTimes(20);
    expect(turns).toBeLessThan(composedTurnCap);
    expectRecoveryStop(messages);
  });

  it("runs a corrected call after repeated argument-validation failures", async () => {
    const { messages, execExecute } = await runComposedLoop("run-corrected", (turn) =>
      turn <= 12
        ? [{ type: "toolCall", id: `exec-${turn}`, name: "exec", arguments: {} }]
        : turn === 13
          ? [{ type: "toolCall", id: "exec-fixed", name: "exec", arguments: { command: "ls" } }]
          : [],
    );

    expect(firstLoopBlock(messages)).toBeUndefined();
    expect(execExecute).toHaveBeenCalledTimes(1);
    expect(execExecute.mock.calls[0]?.[1]).toEqual({ command: "ls" });
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  });

  it("returns a typed critical intervention and records only veto evidence", async () => {
    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    const pollArgs = { action: "poll", sessionId: "process-1" };
    for (let index = 0; index < 20; index += 1) {
      const toolCallId = `prior-${index}`;
      recordToolCall(state, "process", pollArgs, toolCallId, ctx.loopDetection, {
        runId: ctx.runId,
      });
      recordToolCallOutcome(state, {
        toolName: "process",
        toolParams: pollArgs,
        toolCallId,
        result: {
          content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
          details: { status: "running" },
        },
        config: ctx.loopDetection,
        runId: ctx.runId,
      });
    }

    const unrelatedSiblings = Array.from({ length: 20 }, (_, index) =>
      call(`safe-sibling-${index}`, "write", {}),
    );
    const admission = await admitToolCallBatch(
      [...unrelatedSiblings, call("repeated", "process", pollArgs)],
      ctx,
    );

    expect(admission).toMatchObject({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: "repeated",
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
    expect(consumeBatchAdmittedToolCall("safe-sibling-0", ctx.runId)).toBe(false);
    await expect(admitToolCallBatch([call("recovery-write", "write", {})], ctx)).resolves.toEqual(
      expect.objectContaining({
        commitReadyCalls: expect.any(Function),
        releaseSkippedCalls: expect.any(Function),
      }),
    );
  });

  it("blocks a batch that crosses the critical threshold within its own candidates", async () => {
    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    const pollArgs = { action: "poll", sessionId: "process-2" };
    for (let index = 0; index < 19; index += 1) {
      const toolCallId = `prior-${index}`;
      recordToolCall(state, "process", pollArgs, toolCallId, ctx.loopDetection, {
        runId: ctx.runId,
      });
      recordToolCallOutcome(state, {
        toolName: "process",
        toolParams: pollArgs,
        toolCallId,
        result: {
          content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
          details: { status: "running" },
        },
        config: ctx.loopDetection,
        runId: ctx.runId,
      });
    }

    const admission = await admitToolCallBatch(
      [call("candidate-20", "process", pollArgs), call("candidate-21", "process", pollArgs)],
      ctx,
    );

    expect(admission).toMatchObject({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: "candidate-21",
        detector: "known_poll_no_progress",
        count: 20,
      },
    });
    expect(state.toolCallHistory).toHaveLength(21);
    expect(consumeBatchAdmittedToolCall("candidate-20", ctx.runId)).toBe(false);
    await expect(
      admitToolCallBatch([call("recovery-repeat", "process", pollArgs)], ctx),
    ).resolves.toMatchObject({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: "recovery-repeat",
        detector: "known_poll_no_progress",
      },
    });
  });

  it("records an admitted call once and skips only its duplicate single-call loop policy", async () => {
    const admitted = call("admitted", "read", { path: "/tmp/a" });

    const admission = await admitToolCallBatch([admitted], ctx);
    admission.commitReadyCalls?.([{ toolCallId: admitted.toolCall.id, args: admitted.args }]);
    await expect(
      runBeforeToolCallHook({
        toolName: admitted.toolCall.name,
        params: admitted.args,
        toolCallId: admitted.toolCall.id,
        ctx,
      }),
    ).resolves.toMatchObject({ blocked: false });

    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    expect(state.toolCallHistory).toHaveLength(1);
    expect(consumeBatchAdmittedToolCall(admitted.toolCall.id, ctx.runId)).toBe(false);
  });

  it("cleans an admitted marker when a run ends before the wrapped tool consumes it", async () => {
    const admitted = call("blocked-later", "write", {});
    await admitToolCallBatch([admitted], ctx);

    clearBatchAdmittedToolCallsForRun(ctx.runId);

    expect(consumeBatchAdmittedToolCall(admitted.toolCall.id, ctx.runId)).toBe(false);
  });

  it("releases repeated skipped admissions without mutating bounded history", async () => {
    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    for (let index = 0; index < 30; index += 1) {
      recordToolCall(state, "read", { path: `/tmp/prior-${index}` }, `prior-${index}`);
    }
    const originalHistory = [...(state.toolCallHistory ?? [])];
    const diagnosticEvents: unknown[] = [];
    const unsubscribe = onDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      for (let index = 0; index < 25; index += 1) {
        const skipped = call(`skipped-${index}`, "write", { path: "/tmp/skipped" });
        const admission = await admitToolCallBatch([skipped], ctx);
        admission.releaseSkippedCalls?.([skipped.toolCall.id]);
        expect(consumeBatchAdmittedToolCall(skipped.toolCall.id, ctx.runId)).toBe(false);
      }
    } finally {
      unsubscribe();
    }

    expect(state.toolCallHistory).toEqual(originalHistory);
    expect(diagnosticEvents).toEqual([]);
    const executed = call("executed", "write", { path: "/tmp/skipped" });
    const admission = await admitToolCallBatch([executed], ctx);
    admission.commitReadyCalls?.([{ toolCallId: executed.toolCall.id, args: executed.args }]);
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

    admission.commitReadyCalls?.([
      { toolCallId: last.toolCall.id, args: last.args },
      { toolCallId: first.toolCall.id, args: first.args },
    ]);
    admission.releaseSkippedCalls?.([skipped.toolCall.id]);

    const state = getDiagnosticSessionState({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    expect(state.toolCallHistory?.slice(-2).map((record) => record.toolCallId)).toEqual([
      first.toolCall.id,
      last.toolCall.id,
    ]);
    expect(consumeBatchAdmittedToolCall(skipped.toolCall.id, ctx.runId)).toBe(false);
    expect(consumeBatchAdmittedToolCall(sharedId, otherRun.runId)).toBe(true);
    otherAdmission.releaseSkippedCalls?.([sharedId]);
  });
});

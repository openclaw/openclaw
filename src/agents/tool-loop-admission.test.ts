import { beforeEach, describe, expect, it, vi } from "vitest";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "../logging/diagnostic-run-activity.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
import {
  clearBatchAdmittedToolCallsForRun,
  consumeBatchAdmittedToolCall,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { admitToolCallBatch } from "./tool-loop-admission.js";
import { recordToolCall, recordToolCallOutcome } from "./tool-loop-detection.js";
import {
  computeWriteMutationTargetHash,
  stageWriteTargetHashForToolCall,
} from "./tool-loop-write-outcome.js";

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

describe("whole-batch tool-loop admission", () => {
  beforeEach(() => {
    resetDiagnosticRunActivityForTest();
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

  it("preserves the sandbox-resolved write target hash through commitReadyCalls", async () => {
    // Regression (ClawSweeper Rev 25): reconcileToolCallExecutionParams inside
    // commitReadyCall must not overwrite admission's sandbox-resolved hash with
    // host-path fallback when a remote-only @file has no host mapping.
    // Remote-only bridge: no host mapping for workspace files, and a literal
    // remote "@notes.md" exists (stat), so the @ marker must be preserved.
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      relativePath: filePath.replace(/^\/+/, ""),
      containerPath: `/container/workspace/${filePath.replace(/^\/+/, "")}`,
    }));
    const stat = vi.fn(({ filePath }: { filePath: string }) =>
      filePath.replace(/^\/+/, "") === "@notes.md" ? { type: "file" } : null,
    );
    const sandboxCtx: HookContext = {
      ...ctx,
      sandbox: {
        root: "/container/workspace",
        bridge: { resolvePath, stat },
      } as unknown as HookContext["sandbox"],
    };
    const state = getDiagnosticSessionState(sandboxCtx);
    const atArgs = { path: "@notes.md" };
    const plainArgs = { path: "notes.md" };
    try {
      for (let index = 0; index < 2; index += 1) {
        const a = call(`at-${index}`, "write", atArgs);
        const b = call(`plain-${index}`, "write", plainArgs);
        const admissionAt = await admitToolCallBatch([a], sandboxCtx);
        const admissionPlain = await admitToolCallBatch([b], sandboxCtx);
        admissionAt.commitReadyCalls?.([{ toolCallId: a.toolCall.id, args: atArgs }]);
        admissionPlain.commitReadyCalls?.([{ toolCallId: b.toolCall.id, args: plainArgs }]);
      }
      const hashes = (state.toolCallHistory ?? [])
        .filter((entry) => entry.toolName === "write")
        .map((entry) => entry.mutationTargetHash);
      expect(hashes.filter((h) => h !== undefined).length).toBe(4);
      const atHashes = new Set([hashes[0], hashes[2]]);
      const plainHashes = new Set([hashes[1], hashes[3]]);
      expect(atHashes.size).toBe(1);
      expect(plainHashes.size).toBe(1);
      expect([...atHashes][0]).not.toBe([...plainHashes][0]);
    } finally {
      resetDiagnosticRunActivityForTest();
      resetDiagnosticSessionStateForTest();
    }
  });

  it("commits the staged final-args write target hash over the admitted one", async () => {
    // Remote-only bridge like the sibling test; admission hashes the original
    // @-marked path, but a before-tool hook rewrites the argument to the plain
    // name. The wrapper stages the final-args hash; commit must prefer it.
    const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
      relativePath: filePath.replace(/^\/+/, ""),
      containerPath: `/container/workspace/${filePath.replace(/^\/+/, "")}`,
    }));
    const stat = vi.fn(({ filePath }: { filePath: string }) =>
      filePath.replace(/^\/+/, "") === "@notes.md" ? { type: "file" } : null,
    );
    const sandboxCtx: HookContext = {
      ...ctx,
      sandbox: {
        root: "/container/workspace",
        bridge: { resolvePath, stat },
      } as unknown as HookContext["sandbox"],
    };
    const originalArgs = { path: "@notes.md" };
    const rewrittenArgs = { path: "draft.md" };
    const batchCall = call("rewrite-1", "write", originalArgs);
    try {
      const admission = await admitToolCallBatch([batchCall], sandboxCtx);
      // Simulate the wrapper path: compute + stage the hash for FINAL args.
      const stagedHash = await computeWriteMutationTargetHash({
        toolName: "write",
        toolParams: rewrittenArgs,
        cwd: undefined,
        sandbox: sandboxCtx.sandbox,
      });
      stageWriteTargetHashForToolCall(
        { runId: sandboxCtx.runId, toolCallId: batchCall.toolCall.id },
        stagedHash,
      );
      admission.commitReadyCalls?.([{ toolCallId: batchCall.toolCall.id, args: rewrittenArgs }]);
      const state = getDiagnosticSessionState(sandboxCtx);
      // Admission's advisory projection also records this callId with the
      // original args; the committed record is the last one for the id.
      const record = (state.toolCallHistory ?? []).findLast(
        (entry) => entry.toolCallId === batchCall.toolCall.id,
      );
      expect(record?.mutationTargetHash).toBe(stagedHash);
      expect(record?.mutationTargetHash).not.toBe(
        await computeWriteMutationTargetHash({
          toolName: "write",
          toolParams: originalArgs,
          cwd: undefined,
          sandbox: sandboxCtx.sandbox,
        }),
      );
    } finally {
      resetDiagnosticRunActivityForTest();
      resetDiagnosticSessionStateForTest();
    }
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

  it("leaves an established churn lease intact until an admitted escape call completes", async () => {
    markDiagnosticEmbeddedRunStarted({
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
    });
    markDiagnosticArgumentChurnObservation({
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
      active: true,
      now: 1,
    });

    const admitted = call("pending-read-escape", "read", { path: "/tmp/a" });
    const admission = await admitToolCallBatch([admitted], ctx);
    admission.commitReadyCalls?.([{ toolCallId: admitted.toolCall.id, args: admitted.args }]);

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
      }),
    ).toMatchObject({
      lastProgressReason: "tool_loop:argument_churn",
    });
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

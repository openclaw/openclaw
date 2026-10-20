import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTurnSequenceStream,
  model,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import { Agent } from "../../packages/agent-core/src/agent.js";
import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import {
  createToolLoopBatchAdmission,
  installToolLoopRecoveryCleanup,
} from "./embedded-agent-runner/run/tool-loop-recovery.js";
import { setInternalBeforeToolBatch } from "./runtime/internal-hooks.js";

afterEach(() => {
  resetCommandQueueStateForTest();
  resetDiagnosticSessionStateForTest();
  vi.useRealTimers();
});

it.each([false, true])(
  "bounds repeated waits while preserving meaningful progress=%s",
  async (progress) => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(1_000);
    const ctx = {
      sessionId: "wait-session",
      sessionKey: "agent:main:subagent:wait-loop",
      runId: "wait-run",
      loopDetection: { enabled: true },
    };
    let executed = 0;
    const tool: AgentTool = {
      name: "wait",
      label: "wait",
      description: "Resume a pending cell",
      parameters: Type.Object({ runId: Type.String() }),
      execute: async () => {
        executed++;
        vi.advanceTimersByTime(2_500);
        const details = {
          status: "waiting",
          runId: "cell-1",
          reason: "pending_tools",
          pendingToolCalls: [{ id: "pending-1", method: "call" }],
          output: progress ? [{ type: "text", text: `result ${executed}` }] : [],
          telemetry: { callCount: 1 },
        };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    };
    const agent = new Agent({
      initialState: { model, tools: [wrapToolWithBeforeToolCallHook(tool, ctx)] },
      streamFn: createTurnSequenceStream([
        ...Array.from({ length: 12 }, (_, index) => [
          {
            type: "toolCall" as const,
            id: `wait-${index + 1}`,
            name: "wait",
            arguments: { runId: "cell-1" },
          },
        ]),
        [{ type: "text", text: "done" }],
      ]),
    });
    setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission(ctx));
    installToolLoopRecoveryCleanup({ agent, runId: ctx.runId });
    const lane = `test:tool-loop:${ctx.sessionKey}`;
    const first = enqueueCommandInLane(lane, () => agent.prompt("finish the task"));
    const onWait = vi.fn();
    const next = enqueueCommandInLane(lane, async () => "queued message ran", {
      warnAfterMs: 0,
      onWait,
    });
    await first;
    await expect(next).resolves.toBe("queued message ran");
    expect(executed).toBe(progress ? 12 : 10);
    expect(agent.state.messages.at(-1)).toMatchObject(
      progress
        ? { role: "assistant", stopReason: "stop" }
        : {
            role: "assistant",
            stopReason: "error",
            errorMessage: expect.stringContaining("tool-loop recovery"),
          },
    );
    expect(onWait).toHaveBeenCalledWith(progress ? 30_000 : 25_000, 0);
  },
);

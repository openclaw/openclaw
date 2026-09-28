import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../packages/agent-core/src/agent.js";
import {
  createAssistantMessageEventStream,
  type Model,
} from "../../packages/agent-core/src/llm.js";
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
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

const model: Model = {
  id: "test-model",
  name: "Test",
  api: "openai-responses",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};

afterEach(() => {
  resetCommandQueueStateForTest();
  resetDiagnosticSessionStateForTest();
  vi.useRealTimers();
});

describe("wait-loop lane recovery", () => {
  it.each([false, true])(
    "bounds repeated waits while preserving meaningful progress=%s",
    async (progress) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);
      const ctx = {
        sessionId: "wait-session",
        sessionKey: "agent:main:subagent:wait-loop",
        runId: "wait-run",
        loopDetection: { enabled: true },
      };
      let executed = 0;
      let requests = 0;
      const tool: AgentTool = {
        name: "wait",
        label: "wait",
        description: "Resume a pending cell",
        parameters: Type.Object({ runId: Type.String() }),
        execute: async () => {
          executed++;
          vi.setSystemTime(Date.now() + 2_500);
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
        streamFn: () => {
          requests++;
          const message = {
            role: "assistant" as const,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createZeroUsageFixture(),
            timestamp: Date.now(),
            stopReason: requests <= 12 ? ("toolUse" as const) : ("stop" as const),
            content:
              requests <= 12
                ? [
                    {
                      type: "toolCall" as const,
                      id: `wait-${requests}`,
                      name: "wait",
                      arguments: { runId: "cell-1" },
                    },
                  ]
                : [{ type: "text" as const, text: "done" }],
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
          return stream;
        },
      });
      setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission(ctx));
      installToolLoopRecoveryCleanup({ agent, runId: ctx.runId });
      const lane = `session:${ctx.sessionKey}`;
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
});

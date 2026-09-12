// Regression for the session_compact tool's reply-owner contract: the turn
// must NOT run the requested compaction itself (it would block delivery and
// trip the active_run guard). The recorded request travels on the settled
// outcome; the finalize side schedules it after delivery settlement, strictly
// later than the deferred lifecycle completes.
import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
} from "./agent-runner-execution.test-support.js";
import type { EmbeddedAgentParams } from "./agent-runner-execution.test-support.js";

const callOrder: string[] = [];
const runAgentRequestedCompactionIfNeededMock = vi.fn(async () => {
  callOrder.push("agentCompaction");
});

vi.mock("./agent-runner-memory.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./agent-runner-memory.js")>();
  return {
    ...mod,
    runAgentRequestedCompactionIfNeeded: runAgentRequestedCompactionIfNeededMock,
  };
});

vi.mock(
  "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js",
  async (importOriginal) => {
    const mod =
      await importOriginal<
        typeof import("../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js")
      >();
    return {
      ...mod,
      createDeferredEmbeddedRunLifecycleManager: (
        params: Parameters<typeof mod.createDeferredEmbeddedRunLifecycleManager>[0],
      ) => {
        const manager = mod.createDeferredEmbeddedRunLifecycleManager(params);
        return {
          ...manager,
          complete: async () => {
            callOrder.push("lifecycleComplete");
            await manager.complete();
          },
        };
      },
    };
  },
);

const state = await setupAgentRunnerExecutionTestState();

async function runTurn(runEmbedded: (params: EmbeddedAgentParams) => Promise<unknown>) {
  state.runEmbeddedAgentMock.mockImplementationOnce(runEmbedded);
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  return await executeAgentTurn({
    commandBody: "hello",
    followupRun: createFollowupRun(),
    sessionCtx: {
      Provider: "whatsapp",
      MessageSid: "msg",
    } as unknown as TemplateContext,
    opts: {} satisfies GetReplyOptions,
    typingSignals: createMockTypingSignaler(),
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    applyReplyToMode: (payload) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),
    resetSessionAfterRoleOrderingConflict: async () => false,
    isHeartbeat: false,
    sessionKey: "main",
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off",
  });
}

describe("executeAgentTurn: agent-requested compaction contract", () => {
  it("surfaces the recorded request without running compaction in-turn", async () => {
    callOrder.length = 0;
    runAgentRequestedCompactionIfNeededMock.mockClear();
    const result = await runTurn(async (params) => {
      // Simulate the session_compact tool recording a compaction request.
      params.onRequestSessionCompaction?.({ focus: "keep the schema decisions" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.agentCompactionRequest).toEqual({
        focus: "keep the schema decisions",
      });
    }
    // Compaction itself belongs to the finalize side, after delivery
    // settlement: the turn only records the request.
    expect(runAgentRequestedCompactionIfNeededMock).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["lifecycleComplete"]);
  });

  it("surfaces no request when the tool never recorded one", async () => {
    callOrder.length = 0;
    runAgentRequestedCompactionIfNeededMock.mockClear();
    const result = await runTurn(async () => ({
      payloads: [{ text: "final" }],
      meta: {},
    }));

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.agentCompactionRequest).toBeUndefined();
    }
    expect(runAgentRequestedCompactionIfNeededMock).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["lifecycleComplete"]);
  });
});

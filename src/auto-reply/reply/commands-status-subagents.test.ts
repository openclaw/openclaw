import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { emitAgentEvent, emitAgentEventForRunContext } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { buildStatusReplyForTest } from "./commands-status.test-support.js";

vi.mock("../../status/status-plugin-health.runtime.js", () => ({
  collectRuntimePluginHealthSnapshot: () => ({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  }),
}));

describe("buildStatusReply execution observations", () => {
  beforeEach(() => {
    clearAgentHarnesses();
    resetSubagentRegistryForTests();
  });

  afterEach(() => {
    clearAgentHarnesses();
    resetSubagentRegistryForTests();
  });

  it("shows canonical successor tool activity resuming after approval without changing counts", async () => {
    const runId = "status-observed-successor";
    const taskRunId = "status-observed-original";
    const childSessionKey = "agent:main:subagent:status-observed";
    addSubagentRunForTests({
      runId,
      taskRunId,
      generation: 2,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "observed worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });
    registerAgentRunContext(runId, { sessionKey: childSessionKey, projectSessionActive: true });
    try {
      emitAgentEvent({
        runId,
        stream: "tool",
        data: { phase: "start", name: "read", toolCallId: "status-read" },
      });
      registerAgentRunContext(runId, { verboseLevel: "on" });
      const running = await buildStatusReplyForTest({});
      const runningDetail = running?.text
        ?.split("\n")
        .find((line) => line.includes("• observed worker"));
      expect(running?.text).toContain("Subagents: 1 active");
      expect(runningDetail).toMatch(/running/i);
      expect(runningDetail).toMatch(/\bread\b/);

      emitAgentEvent({
        runId,
        stream: "execution",
        data: { approval: { id: "status-approval", state: "pending" } },
      });
      const approval = await buildStatusReplyForTest({});
      const approvalDetail = approval?.text
        ?.split("\n")
        .find((line) => line.includes("• observed worker"));
      expect(approvalDetail).toMatch(/wait.*approval/i);
      expect(approvalDetail).not.toMatch(/\brunning\b/i);

      emitAgentEvent({
        runId,
        stream: "execution",
        data: { approval: { id: "overlapping-approval", state: "pending" } },
      });
      emitAgentEvent({
        runId,
        stream: "execution",
        data: { approval: { id: "status-approval", state: "resolved" } },
      });
      expect((await buildStatusReplyForTest({}))?.text).toMatch(/wait.*approval/i);
      emitAgentEvent({
        runId,
        stream: "execution",
        data: { approval: { id: "overlapping-approval", state: "resolved" } },
      });
      emitAgentEvent({
        runId,
        stream: "tool",
        data: { phase: "start", name: "read", toolCallId: "status-read" },
      });
      const resumed = await buildStatusReplyForTest({});
      const resumedDetail = resumed?.text
        ?.split("\n")
        .find((line) => line.includes("• observed worker"));
      expect(resumedDetail).toMatch(/\brunning\b/i);
      expect(resumedDetail).toMatch(/\bread\b/);
      expect(resumedDetail).not.toMatch(/approval/i);
      expect(resumed?.text).toContain("Subagents: 1 active");
      emitAgentEvent({
        runId,
        stream: "tool",
        data: { phase: "result", name: "read", toolCallId: "status-read" },
      });
      const settledTool = await buildStatusReplyForTest({});
      const settledDetail = settledTool?.text
        ?.split("\n")
        .find((line) => line.includes("• observed worker"));
      expect(settledDetail).toMatch(/running/i);
      expect(settledDetail).not.toMatch(/\bread\b/);
      emitAgentEvent({
        runId,
        stream: "execution",
        data: {
          state: "waiting",
          wait: { kind: "approval" },
          sourceId: "native-observer",
          executionId: "native-turn",
        },
      });
      expect((await buildStatusReplyForTest({}))?.text).toMatch(/wait.*approval/i);
      emitAgentEvent({
        runId,
        stream: "execution",
        data: { state: "running", sourceId: "native-observer", executionId: "native-turn" },
      });
      emitAgentEvent({
        runId,
        stream: "execution",
        data: { state: "unknown", sourceId: "retired-observer", invalidate: true },
      });
      const nativeResumed = await buildStatusReplyForTest({});
      expect(nativeResumed?.text).toContain("Subagents: 1 active");
      expect(
        nativeResumed?.text?.split("\n").find((line) => line.includes("• observed worker")),
      ).toMatch(/running/i);
    } finally {
      clearAgentRunContext(runId);
    }
  });

  it("keeps recent ownerless rows and task counts while reporting unknown activity", async () => {
    const runId = "status-ownerless";
    const childSessionKey = "agent:main:subagent:status-ownerless";
    addSubagentRunForTests({
      runId,
      generation: 1,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retained worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});
    const detail = reply?.text?.split("\n").find((line) => line.includes("• retained worker"));

    expect(reply?.text).toContain("Subagents: 1 active");
    expect(detail).toMatch(/unknown|unavailable/i);
    expect(detail).not.toMatch(/\b(running|queued)\b/i);
  });

  it.each(["task", "generation", "incarnation"] as const)(
    "does not borrow activity from a different canonical %s in the same child session",
    async (replacement) => {
      const childSessionKey = "agent:main:subagent:status-replaced";
      const previousRunId = replacement === "incarnation" ? "status-current" : "status-previous";
      const now = Date.now();
      addSubagentRunForTests({
        runId: previousRunId,
        generation: 1,
        childSessionKey,
        task: "previous worker",
        createdAt: now - 2_000,
        startedAt: now - 2_000,
      });
      registerAgentRunContext(previousRunId, {
        sessionKey: childSessionKey,
        projectSessionActive: true,
      });
      try {
        const previousContext = getAgentRunContext(previousRunId);
        if (!previousContext) {
          throw new Error("Expected previous execution context");
        }
        emitAgentEvent({
          runId: previousRunId,
          stream: "tool",
          data: { phase: "start", name: "old-tool", toolCallId: "previous-tool" },
        });
        emitAgentEvent({
          runId: previousRunId,
          stream: "execution",
          data: { approval: { id: "previous-approval", state: "pending" } },
        });
        expect((await buildStatusReplyForTest({}))?.text).toMatch(/wait.*approval/i);
        addSubagentRunForTests({
          runId: "status-current",
          taskRunId: replacement === "generation" ? previousRunId : "status-current",
          generation: 2,
          childSessionKey,
          task: "replacement worker",
          createdAt: now - 1_000,
          startedAt: now - 1_000,
        });
        if (replacement === "incarnation") {
          clearAgentRunContext(previousRunId);
          registerAgentRunContext("status-current", { ...previousContext });
          emitAgentEventForRunContext(
            {
              runId: "status-current",
              stream: "execution",
              data: { approval: { id: "late-previous-approval", state: "pending" } },
            },
            previousContext,
          );
        }
        const reply = await buildStatusReplyForTest({});
        const detail = reply?.text
          ?.split("\n")
          .find((line) => line.includes("• replacement worker"));

        expect(reply?.text).toContain("Subagents: 1 active");
        expect(detail).toMatch(replacement === "incarnation" ? /running/i : /unknown|unavailable/i);
        expect(detail).not.toMatch(/approval|old-tool/i);
        expect(reply?.text).not.toContain("• previous worker");
      } finally {
        clearAgentRunContext(previousRunId);
        clearAgentRunContext("status-current");
      }
    },
  );

  it("retains ended child delivery debt without calling the child active", async () => {
    const parentKey = "agent:main:subagent:status-delivery-parent";
    const now = Date.now();
    addSubagentRunForTests({
      runId: "status-delivery-parent",
      childSessionKey: parentKey,
      task: "delivery orchestrator",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "status-delivery-child",
      childSessionKey: `${parentKey}:subagent:child`,
      requesterSessionKey: parentKey,
      requesterDisplayKey: parentKey,
      task: "completed child",
      createdAt: now - 90_000,
      startedAt: now - 90_000,
      endedAt: now - 30_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: {
        required: true,
        resultText: "private completed result",
        capturedAt: now - 30_000,
      },
      delivery: { status: "pending" },
    });

    const reply = await buildStatusReplyForTest({});
    const detail = reply?.text
      ?.split("\n")
      .find((line) => line.includes("• delivery orchestrator"));

    expect(reply?.text).toContain("Subagents: 1 active");
    expect(detail).toMatch(/pending|delivery|settle/i);
    expect(detail).not.toMatch(/child(?:ren)? active|\brunning\b/i);
    expect(reply?.text).not.toContain("private completed result");
  });
});

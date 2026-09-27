import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubagentTaskBackingDetail } from "../../tasks/task-backing-records.js";
import { createRunningTaskRunCore } from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { buildStatusReplyForTest } from "./commands-status.test-support.js";
import { configureInMemoryTaskRegistryStoreForTests } from "./commands.test-harness.js";

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
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
  });

  afterEach(() => {
    clearAgentHarnesses();
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests({ persist: false });
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
    createRunningTaskRunCore({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey,
      runId: taskRunId,
      task: "observed worker",
      detail: createSubagentTaskBackingDetail(2),
    });
    registerAgentRunContext(runId, { sessionKey: childSessionKey, projectSessionActive: true });
    try {
      emitAgentEvent({
        runId,
        stream: "tool",
        data: { phase: "start", name: "read", toolCallId: "status-read" },
      });
      const running = await buildStatusReplyForTest({});
      const runningDetail = running?.text
        ?.split("\n")
        .find((line) => line.includes("• observed worker"));
      expect(running?.text).toContain("Subagents: 1 active");
      expect(running?.text).toContain("Tasks: 1 active · 1 total");
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
      expect(approval?.text).toContain("Tasks: 1 active · 1 total");

      emitAgentEvent({
        runId,
        stream: "execution",
        data: { approval: { id: "status-approval", state: "resolved" } },
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
      expect(resumed?.text).toContain("Tasks: 1 active · 1 total");
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
    createRunningTaskRunCore({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey,
      runId,
      task: "retained worker",
      detail: createSubagentTaskBackingDetail(1),
    });

    const reply = await buildStatusReplyForTest({});
    const detail = reply?.text?.split("\n").find((line) => line.includes("• retained worker"));

    expect(reply?.text).toContain("Subagents: 1 active");
    expect(reply?.text).toContain("Tasks: 1 active · 1 total");
    expect(detail).toMatch(/unknown|unavailable/i);
    expect(detail).not.toMatch(/\b(running|queued)\b/i);
  });

  it.each(["task", "generation"] as const)(
    "does not borrow approval activity from a different canonical %s in the same child session",
    async (replacement) => {
      const childSessionKey = "agent:main:subagent:status-replaced";
      const now = Date.now();
      addSubagentRunForTests({
        runId: "status-previous",
        generation: 1,
        childSessionKey,
        task: "previous worker",
        createdAt: now - 2_000,
        startedAt: now - 2_000,
      });
      createRunningTaskRunCore({
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        childSessionKey,
        runId: "status-previous",
        task: "previous worker",
        detail: createSubagentTaskBackingDetail(1),
      });
      emitAgentEvent({
        runId: "status-previous",
        stream: "execution",
        data: { approval: { id: "previous-approval", state: "pending" } },
      });
      addSubagentRunForTests({
        runId: "status-current",
        taskRunId: replacement === "generation" ? "status-previous" : "status-current",
        generation: 2,
        childSessionKey,
        task: "replacement worker",
        createdAt: now - 1_000,
        startedAt: now - 1_000,
      });

      const reply = await buildStatusReplyForTest({});
      const detail = reply?.text?.split("\n").find((line) => line.includes("• replacement worker"));

      expect(reply?.text).toContain("Subagents: 1 active");
      expect(detail).toMatch(/unknown|unavailable/i);
      expect(detail).not.toMatch(/approval/i);
      expect(reply?.text).not.toContain("• previous worker");
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

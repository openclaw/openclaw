import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { emitAgentEvent, emitAgentEventForRunContext } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { buildStatusReplyForTest } from "./commands-status.test-support.js";

type AgentEvent = Parameters<typeof emitAgentEvent>[0];
const started = (timestamp: number) => ({ createdAt: timestamp, startedAt: timestamp });
function emit(runId: string, stream: AgentEvent["stream"], data: AgentEvent["data"]) {
  emitAgentEvent({ runId, stream, data });
}

async function expectWorker(task: string, matches: RegExp[], excludes: RegExp[] = []) {
  const reply = await buildStatusReplyForTest({});
  expect(reply?.text).toContain("Subagents: 1 active");
  const detail = reply?.text?.split("\n").find((line) => line.includes(`• ${task}`));
  for (const pattern of matches) {
    expect(detail).toMatch(pattern);
  }
  for (const pattern of excludes) {
    expect(detail).not.toMatch(pattern);
  }
  return reply;
}

function registerContext(runId: string, sessionKey: string) {
  registerAgentRunContext(runId, { sessionKey, projectSessionActive: true });
  onTestFinished(() => clearAgentRunContext(runId));
}

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
  beforeEach(async () => {
    setRuntimeConfigSnapshot({});
    clearAgentHarnesses();
    await resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    clearAgentHarnesses();
    await resetSubagentRegistryForTests({ persist: false });
    clearRuntimeConfigSnapshot();
  });

  it("shows canonical successor tool activity resuming after approval without changing counts", async () => {
    const runId = "status-observed-successor";
    const childSessionKey = "agent:main:subagent:status-observed";
    seedSubagentRunForReadTest({
      runId,
      taskRunId: "status-observed-original",
      generation: 2,
      childSessionKey,
      task: "observed worker",
      ...started(Date.now() - 60_000),
    });
    registerContext(runId, childSessionKey);
    emit(runId, "tool", { phase: "start", name: "read", toolCallId: "status-read" });
    registerAgentRunContext(runId, { verboseLevel: "on" });
    await expectWorker("observed worker", [/running/i, /\bread\b/]);

    emit(runId, "execution", { approval: { id: "status-approval", state: "pending" } });
    await expectWorker("observed worker", [/wait.*approval/i], [/\brunning\b/i]);

    emit(runId, "execution", { approval: { id: "overlapping-approval", state: "pending" } });
    emit(runId, "execution", { approval: { id: "status-approval", state: "resolved" } });
    expect((await buildStatusReplyForTest({}))?.text).toMatch(/wait.*approval/i);
    emit(runId, "execution", { approval: { id: "overlapping-approval", state: "resolved" } });
    emit(runId, "tool", { phase: "start", name: "read", toolCallId: "status-read" });
    await expectWorker("observed worker", [/\brunning\b/i, /\bread\b/], [/approval/i]);
    emit(runId, "tool", { phase: "result", name: "read", toolCallId: "status-read" });
    await expectWorker("observed worker", [/running/i], [/\bread\b/]);
    emit(runId, "execution", {
      state: "waiting",
      wait: { kind: "approval" },
      sourceId: "native-observer",
      executionId: "native-turn",
    });
    expect((await buildStatusReplyForTest({}))?.text).toMatch(/wait.*approval/i);
    emit(runId, "execution", {
      state: "running",
      sourceId: "native-observer",
      executionId: "native-turn",
    });
    emit(runId, "execution", {
      state: "unknown",
      sourceId: "retired-observer",
      invalidate: true,
    });
    await expectWorker("observed worker", [/running/i]);
  });

  it.each(["task", "generation", "incarnation"] as const)(
    "does not borrow activity from a different canonical %s in the same child session",
    async (replacement) => {
      const childSessionKey = "agent:main:subagent:status-replaced";
      const previousRunId = replacement === "incarnation" ? "status-current" : "status-previous";
      const now = Date.now();
      seedSubagentRunForReadTest({
        runId: previousRunId,
        generation: 1,
        childSessionKey,
        task: "previous worker",
        ...started(now - 2_000),
      });
      registerContext(previousRunId, childSessionKey);
      const previousContext = getAgentRunContext(previousRunId);
      assert(previousContext, "Expected previous execution context");
      emit(previousRunId, "tool", {
        phase: "start",
        name: "old-tool",
        toolCallId: "previous-tool",
      });
      emit(previousRunId, "execution", {
        approval: { id: "previous-approval", state: "pending" },
      });
      expect((await buildStatusReplyForTest({}))?.text).toMatch(/wait.*approval/i);
      seedSubagentRunForReadTest({
        runId: "status-current",
        taskRunId: replacement === "generation" ? previousRunId : "status-current",
        generation: 2,
        childSessionKey,
        task: "replacement worker",
        ...started(now - 1_000),
      });
      if (replacement === "incarnation") {
        clearAgentRunContext(previousRunId);
        registerAgentRunContext("status-current", { ...previousContext });
        onTestFinished(() => clearAgentRunContext("status-current"));
        emitAgentEventForRunContext(
          {
            runId: "status-current",
            stream: "execution",
            data: { approval: { id: "late-previous-approval", state: "pending" } },
          },
          previousContext,
        );
      }
      const reply = await expectWorker(
        "replacement worker",
        [replacement === "incarnation" ? /running/i : /unknown|unavailable/i],
        [/approval|old-tool/i, ...(replacement === "incarnation" ? [] : [/\b(running|queued)\b/i])],
      );
      expect(reply?.text).not.toContain("• previous worker");
    },
  );

  it("retains ended child delivery debt without calling the child active", async () => {
    const parentKey = "agent:main:subagent:status-delivery-parent";
    const now = Date.now();
    seedSubagentRunForReadTest({
      runId: "status-delivery-parent",
      childSessionKey: parentKey,
      task: "delivery orchestrator",
      ...started(now - 120_000),
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    });
    seedSubagentRunForReadTest({
      runId: "status-delivery-child",
      childSessionKey: `${parentKey}:subagent:child`,
      requesterSessionKey: parentKey,
      requesterDisplayKey: parentKey,
      task: "completed child",
      ...started(now - 90_000),
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
    const reply = await expectWorker(
      "delivery orchestrator",
      [/pending|delivery|settle/i],
      [/child(?:ren)? active|\brunning\b/i],
    );
    expect(reply?.text).not.toContain("private completed result");
  });
});

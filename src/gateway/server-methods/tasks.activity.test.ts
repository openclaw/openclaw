import { describe, expect, it } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { markTaskTerminalById } from "../../tasks/runtime-internal.js";
import { createTaskFixture } from "../../tasks/task-registry.test-support.js";
import {
  getTaskPayload,
  mainSessionTaskScope,
  useTaskGatewayFixture,
} from "./tasks.fixture.test-support.js";
import { runTaskHandler } from "./tasks.test-helpers.js";

useTaskGatewayFixture();

describe("tasks gateway execution and activity", () => {
  it.each([
    { status: "succeeded", ledgerStatus: "completed", executionState: "finished" },
    { status: "lost", ledgerStatus: "failed", executionState: "unknown" },
  ] as const)(
    "projects $status without inventing execution completion",
    async ({ status, ledgerStatus, executionState }) => {
      const task = createTaskFixture("cli", {
        ...mainSessionTaskScope,
        runId: "run-completed",
        task: "Done task",
        status,
        deliveryStatus: "not_applicable",
      });

      const { payload } = await getTaskPayload(task.taskId);

      expect(payload?.task?.status).toBe(ledgerStatus);
      expect(payload?.task?.execution).toMatchObject({ state: executionState });
      expect(payload?.task?.title).toBe("Done task");
      expect(payload?.task?.prompt).toBe("Done task");
    },
  );

  it("exposes tool activity in task summaries", async () => {
    const task = createTaskFixture("subagent", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:activity",
      runId: "run-tool-activity",
      task: "Sweep the repo",
      status: "running",
      deliveryStatus: "not_applicable",
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "call-1" },
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "call-2" },
    });

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.toolUseCount).toBe(2);
    expect(payload?.task?.lastToolName).toBe("exec");
    expect(payload?.task?.execution).toMatchObject({
      state: "running",
      currentTool: { name: "exec", startedAt: expect.any(Number) },
    });

    // Completing the latest concurrent call exposes the older call still in flight.
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "tool",
      data: { phase: "result", name: "exec", toolCallId: "call-2", isError: true },
    });
    const reading = await getTaskPayload(task.taskId);
    expect(reading.payload?.task?.execution).toMatchObject({ currentTool: { name: "read" } });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "tool",
      data: { phase: "result", name: "read", toolCallId: "call-1" },
    });
    const finishedTools = await getTaskPayload(task.taskId);
    expect(finishedTools.payload?.task?.execution).not.toHaveProperty("currentTool");
    expect(finishedTools.payload?.task?.lastToolName).toBe("exec");
    expect(finishedTools.payload?.task?.status).toBe("running");

    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "execution",
      data: { state: "running", executionId: "turn-1" },
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "call-3" },
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "execution",
      data: { state: "waiting", wait: { kind: "approval" } },
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "assistant",
      data: { text: "Still waiting for approval." },
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "overlapping-read" },
    });
    expect((await getTaskPayload(task.taskId)).payload?.task?.execution).toMatchObject({
      state: "waiting",
      wait: { kind: "approval" },
    });
    // A replacement turn clears an unfinished call even when its completion was lost.
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "execution",
      data: { state: "running", executionId: "turn-2" },
    });
    expect((await getTaskPayload(task.taskId)).payload?.task?.execution).not.toHaveProperty(
      "currentTool",
    );
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "execution",
      data: { state: "unknown", executionId: "turn-2" },
    });
    const idle = (await getTaskPayload(task.taskId)).payload?.task;
    expect(idle?.execution).toMatchObject({ state: "unknown" });
    expect(idle?.status).toBe("running");

    for (const sourceId of ["connection-1", "connection-2"]) {
      emitAgentEvent({
        runId: "run-tool-activity",
        stream: "execution",
        data: { state: "running", sourceId, executionId: "turn-3" },
      });
      expect((await getTaskPayload(task.taskId)).payload?.task?.execution).not.toHaveProperty(
        "currentTool",
      );
      emitAgentEvent({
        runId: "run-tool-activity",
        stream: "tool",
        data: { phase: "start", name: "exec", toolCallId: sourceId },
      });
    }
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "execution",
      data: { state: "unknown", sourceId: "connection-1", invalidate: true },
    });
    expect((await getTaskPayload(task.taskId)).payload?.task?.execution).toMatchObject({
      state: "running",
      currentTool: { name: "exec" },
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "execution",
      data: { state: "unknown", sourceId: "connection-2", invalidate: true },
    });
    expect((await getTaskPayload(task.taskId)).payload?.task?.execution).toMatchObject({
      state: "unknown",
    });
  });

  it("keeps task attention until its current approvals resolve", async () => {
    const task = createTaskFixture("subagent", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:approvals",
      runId: "run-approvals",
      task: "Run two approved commands",
      status: "running",
      deliveryStatus: "not_applicable",
    });
    const approval = (id: string, state: "pending" | "resolved") =>
      emitAgentEvent({
        runId: "run-approvals",
        stream: "execution",
        data: { approval: { id, state } },
      });
    approval("first", "pending");
    approval("second", "pending");
    emitAgentEvent({
      runId: "run-approvals",
      stream: "assistant",
      data: { text: "Both commands need approval." },
    });
    expect((await getTaskPayload(task.taskId)).payload?.task?.execution).toMatchObject({
      state: "waiting",
      wait: { kind: "approval" },
    });
    approval("unrelated", "resolved");
    approval("first", "resolved");
    expect((await getTaskPayload(task.taskId)).payload?.task?.execution).toMatchObject({
      state: "waiting",
    });
    approval("second", "resolved");
    expect((await getTaskPayload(task.taskId)).payload?.task?.execution).toMatchObject({
      state: "running",
    });
    // Historical tool-result presentation is not the live approval authority.
    emitAgentEvent({
      runId: "run-approvals",
      stream: "approval",
      data: { phase: "requested", approvalId: "old", status: "pending" },
    });
    expect((await getTaskPayload(task.taskId)).payload?.task?.execution).toMatchObject({
      state: "running",
    });
  });

  it("projects isolated live subagent activity and best-effort diff stats", async () => {
    const primary = createTaskFixture("subagent", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:primary",
      runId: "run-live-primary",
      task: "Implement task activity",
      status: "running",
      deliveryStatus: "not_applicable",
      progressSummary: "Milestone remains authoritative",
    });
    const secondary = createTaskFixture("subagent", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:secondary",
      runId: "run-live-secondary",
      task: "Review task activity",
      status: "running",
      deliveryStatus: "not_applicable",
    });
    const longLastLine = `Updating   files ${"x".repeat(220)}`;
    const emitPrimaryTool = (data: Record<string, unknown>) =>
      emitAgentEvent({ runId: primary.runId!, stream: "tool", data });

    emitAgentEvent({
      runId: primary.runId!,
      stream: "thinking",
      data: { text: "Inspecting the fold\nThinking fallback" },
    });
    emitAgentEvent({
      runId: secondary.runId!,
      stream: "thinking",
      data: { text: "Checking isolation\n  Thinking-only   progress  " },
    });
    emitAgentEvent({
      runId: primary.runId!,
      stream: "assistant",
      data: { text: `Earlier line\n\n${longLastLine}` },
    });
    emitAgentEvent({
      runId: primary.runId!,
      stream: "thinking",
      data: { text: "Later thinking must not replace assistant activity" },
    });
    emitPrimaryTool({
      phase: "start",
      name: "edit",
      toolCallId: "edit-1",
      args: {
        path: "src/a.ts",
        edits: [{ oldText: "one\ntwo", newText: "one\nthree\nfour" }],
      },
    });
    emitPrimaryTool({ phase: "result", name: "edit", toolCallId: "edit-1", isError: false });
    emitPrimaryTool({
      phase: "start",
      name: "write",
      toolCallId: "write-1",
      args: { file_path: "src/b.ts", content: "alpha\nbeta" },
    });
    emitPrimaryTool({ phase: "result", name: "write", toolCallId: "write-1", isError: false });
    emitPrimaryTool({
      phase: "start",
      name: "apply_patch",
      toolCallId: "patch-1",
      args: {
        input: [
          "*** Begin Patch",
          "*** Update File: src/a.ts",
          "@@",
          "-old",
          "+new",
          "+newer",
          "*** Delete File: src/c.ts",
          "*** End Patch",
        ].join("\n"),
      },
    });
    emitPrimaryTool({
      phase: "result",
      name: "apply_patch",
      toolCallId: "patch-1",
      isError: false,
    });
    emitPrimaryTool({
      phase: "start",
      name: "write",
      toolCallId: "write-failed",
      args: { path: "src/ignored.ts", content: "not\ncounted" },
    });
    emitPrimaryTool({ phase: "result", name: "write", toolCallId: "write-failed", isError: true });

    const primaryGet = await getTaskPayload(primary.taskId);
    const secondaryGet = await getTaskPayload(secondary.taskId);
    const listed = await runTaskHandler("tasks.list", {});
    const listedPrimary = listed.payload?.tasks?.find((task) => task.id === primary.taskId);

    expect(primaryGet.payload?.task?.lastActivity).toMatch(/^Updating files x+…$/);
    expect(String(primaryGet.payload?.task?.lastActivity).length).toBeLessThanOrEqual(200);
    expect(primaryGet.payload?.task?.diffStat).toEqual({ files: 3, added: 7, removed: 3 });
    expect(primaryGet.payload?.task?.progressSummary).toBe("Milestone remains authoritative");
    expect(secondaryGet.payload?.task?.lastActivity).toBe("Thinking-only progress");
    expect(secondaryGet.payload?.task).not.toHaveProperty("diffStat");
    expect(listedPrimary?.lastActivity).toBe(primaryGet.payload?.task?.lastActivity);
    expect(listedPrimary?.diffStat).toEqual(primaryGet.payload?.task?.diffStat);

    markTaskTerminalById({ taskId: primary.taskId, status: "succeeded", endedAt: Date.now() });
    const terminal = await getTaskPayload(primary.taskId);
    expect(terminal.payload?.task).not.toHaveProperty("lastActivity");
    expect(terminal.payload?.task).not.toHaveProperty("diffStat");
    expect(terminal.payload?.task?.progressSummary).toBe("Milestone remains authoritative");
  });
});

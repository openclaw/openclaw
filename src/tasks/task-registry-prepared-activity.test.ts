import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentActivityItem } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { createSubagentTaskBackingDetail } from "./task-backing-records.js";
import { getTaskPreparedActivity, recordTaskActivityEvent } from "./task-registry-activity.js";
import { updateTaskStateByRunId } from "./task-registry-record-api.js";
import { getTaskById, markTaskTerminalById } from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

beforeEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
  configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
});

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
});

describe("prepared task activity", () => {
  it("retains only prepared public item snapshots before a task yields", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-activity",
      runId: "run-prepared-activity",
      task: "Prepare public progress",
    });
    const prepared = {
      itemId: "tool:command-1",
      kind: "tool",
      phase: "end",
      status: "blocked",
      title: "Run focused tests",
      progressText: "Waiting for command approval",
      toolCallId: "command-1",
      name: "exec",
      meta: "pnpm test",
      commandBearing: true,
      startedAt: 100,
      endedAt: 200,
      error: "Approval required",
      summary: "Awaiting approval before command can run.",
      approvalId: "approval-1",
      approvalSlug: "test-command",
      hideFromChannelProgress: false,
      suppressChannelProgress: false,
    } satisfies AgentActivityItem;
    const data = {
      ...prepared,
      args: { command: "private command arguments" },
      result: { content: [{ type: "text", text: "private command output" }] },
      text: "private assistant buffer",
      thinking: "private reasoning buffer",
      delta: "private delta",
      privateTelemetry: { secret: "private event field" },
    };
    emitAgentEvent({ runId: task.runId!, stream: "item", data });
    emitAgentEvent({
      runId: task.runId!,
      stream: "assistant",
      data: { text: "Private assistant activity" },
    });
    emitAgentEvent({
      runId: task.runId!,
      stream: "thinking",
      data: { text: "Private reasoning activity" },
    });
    data.title = "Mutated after emission";
    expect(getTaskPreparedActivity(task.taskId)).toEqual(new Map([[prepared.itemId, prepared]]));

    const replacement = {
      itemId: prepared.itemId,
      kind: "tool",
      phase: "end",
      status: "completed",
      title: "Tests passed",
    } satisfies AgentActivityItem;
    emitAgentEvent({ runId: task.runId!, stream: "item", data: replacement });
    const preamble = {
      itemId: "commentary-1",
      kind: "preamble",
      phase: "end",
      title: "Commentary",
      progressText: "The focused tests passed.",
    } satisfies AgentActivityItem;
    emitAgentEvent({ runId: task.runId!, stream: "item", data: preamble });
    expect(getTaskPreparedActivity(task.taskId)).toEqual(
      new Map<string, AgentActivityItem>([
        [replacement.itemId, replacement],
        [preamble.itemId, preamble],
      ]),
    );
  });

  it("retains anonymous public preambles only at complete host-sequenced boundaries", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:anonymous-preamble",
      runId: "run-anonymous-preamble",
      task: "Report prepared commentary",
    });
    for (const phase of ["start", "update"]) {
      emitAgentEvent({
        runId: task.runId!,
        stream: "item",
        data: {
          kind: "preamble",
          phase,
          title: "Preamble",
          progressText: "Checking the command",
        },
      });
    }
    expect(getTaskPreparedActivity(task.taskId)?.size).toBe(0);
    const completed = {
      kind: "preamble",
      phase: "end",
      title: "Preamble",
      progressText: "Checking the command output.",
    };
    emitAgentEvent({ runId: task.runId!, stream: "item", data: completed });
    emitAgentEvent({
      runId: task.runId!,
      stream: "item",
      data: { ...completed, progressText: "The command finished." },
    });
    expect(getTaskPreparedActivity(task.taskId)).toEqual(
      new Map([
        ["preamble:3", { ...completed, itemId: "preamble:3" }],
        [
          "preamble:4",
          { ...completed, itemId: "preamble:4", progressText: "The command finished." },
        ],
      ]),
    );
  });

  it("bounds prepared activity while retaining the latest replacement of an item", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-bound",
      runId: "run-prepared-bound",
      task: "Bound public progress",
    });
    const emitItem = (index: number, phase: "start" | "end" = "start") =>
      emitAgentEvent({
        runId: task.runId!,
        stream: "item",
        data: {
          itemId: `tool:command-${index}`,
          kind: "tool",
          phase,
          title: `Command ${index}`,
          status: phase === "end" ? "completed" : "running",
        },
      });
    for (let index = 0; index < 64; index += 1) {
      emitItem(index);
    }
    emitItem(0, "end");
    emitItem(64);
    const items = expectDefined(getTaskPreparedActivity(task.taskId), "prepared task activity");
    expect(items.size).toBe(64);
    expect(items.has("tool:command-1")).toBe(false);
    expect(items.get("tool:command-0")).toMatchObject({
      phase: "end",
      status: "completed",
    });
    expect(items.get("tool:command-64")).toMatchObject({ status: "running" });
  });

  it("keeps visible work through hidden polling and retracts hidden item replacements", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-visibility",
      runId: "run-prepared-visibility",
      task: "Keep public work visible",
    });
    const command = {
      itemId: "command-1",
      kind: "tool",
      phase: "start",
      title: "Run focused tests",
      status: "running",
    } satisfies AgentActivityItem;
    const otherCommand = { ...command, itemId: "command-2", title: "Check changed files" };
    emitAgentEvent({ runId: task.runId!, stream: "item", data: command });
    emitAgentEvent({ runId: task.runId!, stream: "item", data: otherCommand });
    for (let index = 0; index < 65; index += 1) {
      emitAgentEvent({
        runId: task.runId!,
        stream: "item",
        data: {
          itemId: `poll-${index}`,
          kind: "tool",
          name: "process",
          phase: "end",
          title: "Poll command",
          status: "completed",
          hideFromChannelProgress: index % 2 === 0,
          suppressChannelProgress: index % 2 !== 0,
        },
      });
    }
    emitAgentEvent({
      runId: task.runId!,
      stream: "item",
      data: {
        itemId: "analysis-1",
        kind: "analysis",
        phase: "end",
        title: "Private reasoning",
        progressText: "Private reasoning must not become public activity.",
      },
    });
    expect(getTaskPreparedActivity(task.taskId)).toEqual(
      new Map([
        [command.itemId, command],
        [otherCommand.itemId, otherCommand],
      ]),
    );
    for (const [index, item] of [command, otherCommand].entries()) {
      const retraction = recordTaskActivityEvent(task, {
        runId: task.runId!,
        seq: 100 + index,
        ts: 400 + index,
        stream: "item",
        data: {
          ...item,
          phase: "end",
          title: "Private replacement title",
          progressText: "Private replacement progress",
          summary: "Private replacement summary",
          result: { content: [{ type: "text", text: "Private command output" }] },
          hideFromChannelProgress: index === 0,
          suppressChannelProgress: index === 1,
        },
      });
      expect(JSON.stringify(retraction ?? null)).not.toContain("Private");
    }
    expect(getTaskPreparedActivity(task.taskId)?.size).toBe(0);
  });

  it("discards replaced overlays but preserves returned public facts through terminal cleanup", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-generation",
      runId: "run-prepared-generation",
      task: "Resume public progress",
    });
    emitAgentEvent({
      runId: task.runId!,
      stream: "item",
      data: {
        itemId: "predecessor-command",
        kind: "tool",
        phase: "start",
        title: "Predecessor command",
      },
    });
    recordTaskActivityEvent(task, {
      runId: "run-prepared-successor",
      seq: 1,
      ts: 300,
      stream: "execution",
      data: { state: "running" },
    });
    expect(getTaskPreparedActivity(task.taskId)?.size).toBe(0);
    const successor = {
      itemId: "successor-commentary",
      kind: "preamble",
      phase: "end",
      title: "Commentary",
      progressText: "Continuing with the replacement execution.",
    } satisfies AgentActivityItem;
    const prepared = recordTaskActivityEvent(task, {
      runId: "run-prepared-successor",
      seq: 2,
      ts: 400,
      stream: "item",
      data: {
        ...successor,
        result: { content: [{ type: "text", text: "Private final output" }] },
      },
    });
    const items = expectDefined(getTaskPreparedActivity(task.taskId), "prepared task activity");
    expect(items).toEqual(new Map([[successor.itemId, successor]]));
    markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 500 });
    expect(getTaskPreparedActivity(task.taskId)).toBeUndefined();
    expect(items.size).toBe(0);
    expect(prepared).toEqual(successor);
  });

  it("rejects predecessor items before a same-run generation replacement emits activity", () => {
    const task = createTaskFixture("subagent", {
      childSessionKey: "agent:main:subagent:prepared-same-run",
      runId: "run-prepared-same-run",
      task: "Replace the backing generation",
      detail: createSubagentTaskBackingDetail(1),
    });
    recordTaskActivityEvent(task, {
      runId: task.runId!,
      seq: 1,
      ts: 100,
      stream: "item",
      data: {
        itemId: "predecessor-command",
        kind: "tool",
        phase: "start",
        title: "Predecessor command",
      },
    });
    expect(getTaskPreparedActivity(task.taskId)?.has("predecessor-command")).toBe(true);
    updateTaskStateByRunId({
      taskId: task.taskId,
      runId: task.runId!,
      runtime: "subagent",
      detail: createSubagentTaskBackingDetail(2),
    });
    expect(getTaskPreparedActivity(task.taskId)).toBeUndefined();

    const successor = {
      itemId: "successor-command",
      kind: "tool",
      phase: "start",
      title: "Replacement command",
    } satisfies AgentActivityItem;
    recordTaskActivityEvent(expectDefined(getTaskById(task.taskId), "replacement task"), {
      runId: task.runId!,
      seq: 2,
      ts: 200,
      stream: "item",
      data: successor,
    });
    expect(getTaskPreparedActivity(task.taskId)).toEqual(new Map([[successor.itemId, successor]]));
  });
});

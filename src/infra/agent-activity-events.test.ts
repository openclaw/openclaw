import { beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import {
  emitAgentActivityEvent,
  projectAgentHistoryActivity,
  projectAgentToolActivity,
  type AgentCommandOutputEventData,
  type AgentItemEventData,
  type AgentPatchSummaryEventData,
} from "./agent-activity-events.js";
import {
  type AgentApprovalEventData,
  type AgentEventPayload,
  onAgentEvent,
  resetAgentEventsForTest,
} from "./agent-events.js";

describe("agent activity events", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test.each([
    { outcome: "completed", hidden: true },
    { outcome: "failed", hidden: false },
    { outcome: "execution-failed", hidden: false },
    { outcome: "blocked", hidden: false },
    { outcome: "missing", hidden: false },
    { outcome: "unlinked", hidden: false },
    { outcome: "other-run", hidden: false },
    { outcome: "no-run", hidden: false },
    { outcome: "duplicate", hidden: false },
    { outcome: "result-only", hidden: true },
    { outcome: "no-call-id", hidden: false },
  ])("keeps recorded child failures with a $outcome wrapper", ({ outcome, hidden }) => {
    const runId = outcome === "other-run" ? "other" : outcome === "no-run" ? undefined : "run";
    const wrapper = {
      messageId: "wrapper",
      message: {
        role: "assistant",
        __openclaw: { runId },
        content: [
          {
            type: "toolCall",
            id: outcome === "no-call-id" ? undefined : "outer",
            name: "exec",
            arguments: {},
          },
        ],
      },
    };
    const messages: Array<{ messageId: string; message: unknown }> =
      outcome === "result-only" ? [] : [wrapper];
    if (outcome === "duplicate") {
      messages.push({ ...wrapper, messageId: "duplicate-wrapper" });
    }
    messages.push({
      messageId: "child",
      message: createNestedToolActivity({
        runId: "run",
        scopeId: "scope",
        afterEntryId: "wrapper",
        startOrder: 1,
        ...(outcome === "unlinked" ? {} : { parentToolCallId: "outer" }),
        toolCallId: "child",
        toolName: "read",
        input: { path: "missing.txt" },
        result: { content: [{ type: "text", text: "Missing file" }] },
        isError: true,
        startedAt: 1,
        timestamp: 2,
      }),
    });
    if (outcome !== "missing") {
      messages.push({
        messageId: "wrapper-result",
        message: {
          role: "toolResult",
          __openclaw: { runId },
          toolCallId: outcome === "no-call-id" ? undefined : "outer",
          toolName: "exec",
          isError: outcome === "failed",
          content: [{ type: "text", text: "Finished" }],
          ...(outcome === "blocked" ? { details: { status: "approval-pending" } } : {}),
          ...(outcome === "execution-failed" ? { details: { status: "failed" } } : {}),
        },
      });
    }
    const projected = projectAgentHistoryActivity(messages);
    expect(projected.find((entry) => entry.messageId === "child")?.items).toEqual([
      expect.objectContaining({ toolCallId: "child", status: "failed" }),
    ]);
    const outer = projected.find(
      (entry) => entry.messageId === (outcome === "result-only" ? "wrapper-result" : "wrapper"),
    )?.items;
    expect(outer).toEqual(hidden ? [] : [expect.objectContaining({ name: "exec" })]);
    if (outcome === "execution-failed") {
      expect(outer).toEqual([expect.objectContaining({ status: "failed" })]);
    }
  });

  test.each([true, false])(
    "does not expose a child assignment in progress (named: %s)",
    (named) => {
      const item = projectAgentToolActivity({
        toolCallId: "spawn-worker",
        name: "sessions_spawn",
        phase: "start",
        args: {
          ...(named ? { label: "Maple", taskName: "verify-release" } : {}),
          task: "PRIVATE_CHILD_ASSIGNMENT: inspect an internal document and report its contents",
        },
      });
      if (named) {
        expect(`${item.title} ${item.meta ?? ""}`).toContain("Maple");
      }
      expect(JSON.stringify(item)).not.toContain("PRIVATE_CHILD_ASSIGNMENT");
    },
  );

  test("emits every activity stream with shared sequencing and context", () => {
    const itemData: AgentItemEventData = {
      itemId: "item-1",
      phase: "start",
      kind: "tool",
      title: "Read",
      status: "running",
    };
    const approvalData: AgentApprovalEventData = {
      phase: "requested",
      kind: "exec",
      status: "pending",
      title: "Approve",
    };
    const commandData: AgentCommandOutputEventData = {
      itemId: "command-1",
      phase: "delta",
      title: "Command",
      toolCallId: "tool-1",
      output: "working",
    };
    const patchData: AgentPatchSummaryEventData = {
      itemId: "patch-1",
      phase: "end",
      title: "Patch",
      toolCallId: "tool-2",
      added: ["new.ts"],
      modified: [],
      deleted: [],
      summary: "Added new.ts",
    };
    const events: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));

    emitAgentActivityEvent({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "item",
      data: itemData,
    });
    emitAgentActivityEvent({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "approval",
      data: approvalData,
    });
    emitAgentActivityEvent({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "command_output",
      data: commandData,
    });
    emitAgentActivityEvent({
      runId: "run-1",
      sessionKey: "",
      stream: "patch",
      data: patchData,
    });

    expect(
      events.map(({ runId, seq, stream, sessionKey }) => ({ runId, seq, stream, sessionKey })),
    ).toEqual([
      { runId: "run-1", seq: 1, stream: "item", sessionKey: "session-1" },
      { runId: "run-1", seq: 2, stream: "approval", sessionKey: "session-1" },
      { runId: "run-1", seq: 3, stream: "command_output", sessionKey: "session-1" },
      { runId: "run-1", seq: 4, stream: "patch", sessionKey: undefined },
    ]);
    expect(events.map((event) => event.data)).toEqual([
      itemData,
      approvalData,
      commandData,
      patchData,
    ]);
    expect(events[0]?.data).toBe(itemData);
    unsubscribe();
  });

  test("rejects mismatched stream and payload pairs", () => {
    type ItemData = Extract<
      Parameters<typeof emitAgentActivityEvent>[0],
      { stream: "item" }
    >["data"];

    expectTypeOf<AgentApprovalEventData>().not.toMatchTypeOf<ItemData>();
  });
});

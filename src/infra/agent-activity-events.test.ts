import { describe, expect, expectTypeOf, test } from "vitest";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import {
  emitAgentActivityEvent,
  projectAgentHistoryActivity,
  projectAgentToolActivity,
} from "./agent-activity-events.js";
import {
  type AgentApprovalEventData,
  type AgentEventPayload,
  onAgentEvent,
  resetAgentEventsForTest,
} from "./agent-events.js";

describe("agent activity events", () => {
  test("emits every activity stream with shared sequencing and context", () => {
    type ItemData = Extract<
      Parameters<typeof emitAgentActivityEvent>[0],
      { stream: "item" }
    >["data"];
    expectTypeOf<AgentApprovalEventData>().not.toMatchTypeOf<ItemData>();

    const inputs: Parameters<typeof emitAgentActivityEvent>[0][] = [
      {
        runId: "run-1",
        sessionKey: "session-1",
        stream: "item",
        data: { itemId: "item-1", phase: "start", kind: "tool", title: "Read", status: "running" },
      },
      {
        runId: "run-1",
        sessionKey: "session-1",
        stream: "approval",
        data: { phase: "requested", kind: "exec", status: "pending", title: "Approve" },
      },
      {
        runId: "run-1",
        sessionKey: "session-1",
        stream: "command_output",
        data: {
          itemId: "command-1",
          phase: "delta",
          title: "Command",
          toolCallId: "tool-1",
          output: "working",
        },
      },
      {
        runId: "run-1",
        sessionKey: "",
        stream: "patch",
        data: {
          itemId: "patch-1",
          phase: "end",
          title: "Patch",
          toolCallId: "tool-2",
          added: ["new.ts"],
          modified: [],
          deleted: [],
          summary: "Added new.ts",
        },
      },
    ];
    resetAgentEventsForTest();
    const events: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));
    try {
      for (const input of inputs) {
        emitAgentActivityEvent(input);
      }
      expect(
        events.map(({ runId, seq, stream, sessionKey }) => ({ runId, seq, stream, sessionKey })),
      ).toEqual([
        { runId: "run-1", seq: 1, stream: "item", sessionKey: "session-1" },
        { runId: "run-1", seq: 2, stream: "approval", sessionKey: "session-1" },
        { runId: "run-1", seq: 3, stream: "command_output", sessionKey: "session-1" },
        { runId: "run-1", seq: 4, stream: "patch", sessionKey: undefined },
      ]);
      expect(events.map((event) => event.data)).toEqual(inputs.map((input) => input.data));
      expect(events[0]?.data).toBe(inputs[0]?.data);
    } finally {
      unsubscribe();
      resetAgentEventsForTest();
    }
  });

  test("projects Tool Search names for live and history activity without changing outcomes or pairing", () => {
    const args = { id: "openclaw:core:exec", args: { command: "check-release" } };
    const tool = { toolCallId: "release-check", name: "tool_call", args };
    expect(projectAgentToolActivity({ ...tool, phase: "start" })).toMatchObject({
      name: "exec",
      toolCallId: tool.toolCallId,
      status: "running",
      commandBearing: true,
    });
    const result = {
      role: "toolResult",
      toolCallId: tool.toolCallId,
      toolName: tool.name,
      details: { status: "completed", exitCode: 2 },
      isError: false,
    };
    // Presentation must not reinterpret the dispatcher's result as a native exec result.
    expect(
      projectAgentToolActivity({ ...tool, phase: "result", result, isError: false }),
    ).toMatchObject({ name: "exec", status: "completed" });

    const skipped = {
      ...result,
      details: { status: "skipped", deniedReason: "steering" },
      isError: true,
    };
    const history = projectAgentHistoryActivity([
      {
        messageId: "call",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: tool.toolCallId, name: tool.name, arguments: args }],
        },
      },
      { messageId: "result", message: skipped },
    ]);
    for (const entry of history) {
      expect(entry.items).toEqual([
        expect.objectContaining({
          name: "exec",
          title: "Exec",
          toolCallId: tool.toolCallId,
          status: "skipped",
          commandBearing: true,
        }),
      ]);
      expect(entry.items[0]?.meta).toBeUndefined();
    }
    expect(skipped.toolName).toBe("tool_call");
    expect(skipped.isError).toBe(true);
  });

  test("derives historical Tool Search metadata from the executed inner input", () => {
    const projected = projectAgentHistoryActivity([
      {
        messageId: "child",
        message: createNestedToolActivity({
          runId: "run",
          scopeId: "scope",
          afterEntryId: "wrapper",
          startOrder: 1,
          toolCallId: "search-read",
          toolName: "tool_call",
          input: { id: "read", args: { path: "notes/release.md" } },
          result: { content: [{ type: "text", text: "Release notes" }] },
          isError: false,
          startedAt: 1,
          timestamp: 2,
        }),
      },
    ]);
    expect(projected[0]?.items).toEqual([
      expect.objectContaining({ name: "read", toolCallId: "search-read" }),
    ]);
    expect(projected[0]?.items[0]?.meta).toContain("release.md");
  });

  test.each([
    { details: { status: "skipped", deniedReason: "steering" }, status: "skipped" },
    { details: { status: "skipped", deniedReason: "other" }, status: "blocked" },
    { details: { status: "approval-pending" }, status: "blocked" },
    { details: { status: "approval-unavailable" }, status: "blocked" },
    { details: { status: "error" }, status: "failed" },
  ])("preserves $details as $status in live and history activity", ({ details, status }) => {
    const result = {
      role: "toolResult",
      toolCallId: "read-context",
      toolName: "read",
      content: [{ type: "text", text: "Tool did not execute." }],
      details,
      isError: true,
    };
    const live = projectAgentToolActivity({
      toolCallId: result.toolCallId,
      name: result.toolName,
      phase: "result",
      result,
      isError: true,
    });
    const history = projectAgentHistoryActivity([{ messageId: "result", message: result }]);
    expect(live.status).toBe(status);
    expect(history[0]?.items).toEqual([expect.objectContaining({ status })]);
    expect(result.isError).toBe(true);
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

  test("keeps a completed step countable when its only child is routine progress", () => {
    const projected = projectAgentHistoryActivity([
      {
        messageId: "step",
        message: {
          role: "assistant",
          runId: "run",
          content: [
            {
              type: "toolCall",
              id: "step",
              name: "exec",
              arguments: {
                title: "Check the release checklist",
                code: "await tools.progress_card({});",
              },
            },
          ],
        },
      },
      {
        messageId: "progress",
        message: createNestedToolActivity({
          runId: "run",
          scopeId: "scope",
          afterEntryId: "step",
          startOrder: 1,
          parentToolCallId: "step",
          toolCallId: "progress",
          toolName: "progress_card",
          input: { action: "update", title: "Release checklist" },
          result: { content: [{ type: "text", text: "Updated" }] },
          isError: false,
          startedAt: 1,
          timestamp: 2,
        }),
      },
      {
        messageId: "result",
        message: {
          role: "toolResult",
          runId: "run",
          toolCallId: "step",
          toolName: "exec",
          isError: false,
          content: [{ type: "text", text: "Finished" }],
        },
      },
    ]);
    expect(projected.find((entry) => entry.messageId === "step")?.items).toEqual([
      expect.objectContaining({ toolCallId: "step", name: "exec", status: "completed" }),
    ]);
    expect(projected.find((entry) => entry.messageId === "progress")?.items).toEqual([]);
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
});

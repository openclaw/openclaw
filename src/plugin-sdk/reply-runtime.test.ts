import { describe, expect, it, vi } from "vitest";
import type { ReplyActivityEvent } from "./reply-runtime.js";
import { createReplyActivityCallbacks } from "./reply-runtime.js";

describe("plugin-sdk/reply-runtime", () => {
  it("maps live reply activity callbacks into one ordered event stream", async () => {
    const seen: ReplyActivityEvent[] = [];
    const callbacks = createReplyActivityCallbacks({
      onEvent: (event) => {
        seen.push(event);
      },
    });

    callbacks.onAgentRunStart?.("run-1");
    await callbacks.onReasoningStream?.({ text: "Thinking...", isReasoning: true });
    await callbacks.onToolStart?.({ name: "exec", phase: "start" });
    await callbacks.onItemEvent?.({
      itemId: "item-1",
      title: "Inspect repo",
      phase: "running",
    });
    await callbacks.onPlanUpdate?.({
      phase: "update",
      explanation: "Inspect, patch, verify.",
      steps: ["Inspect", "Patch", "Verify"],
    });
    await callbacks.onApprovalEvent?.({
      status: "pending",
      command: "pnpm test",
    });
    await callbacks.onCommandOutput?.({
      output: "ok",
      exitCode: 0,
    });
    await callbacks.onPatchSummary?.({
      summary: "1 modified",
    });
    await callbacks.onAssistantMessageStart?.();
    await callbacks.onReasoningEnd?.();

    expect(callbacks.onPartialReply).toBeUndefined();
    expect(seen).toEqual([
      { type: "agent_run_start", payload: { runId: "run-1" } },
      { type: "reasoning", payload: { text: "Thinking...", isReasoning: true } },
      { type: "tool_start", payload: { name: "exec", phase: "start" } },
      {
        type: "item",
        payload: {
          itemId: "item-1",
          title: "Inspect repo",
          phase: "running",
        },
      },
      {
        type: "plan_update",
        payload: {
          phase: "update",
          explanation: "Inspect, patch, verify.",
          steps: ["Inspect", "Patch", "Verify"],
        },
      },
      {
        type: "approval",
        payload: {
          status: "pending",
          command: "pnpm test",
        },
      },
      {
        type: "command_output",
        payload: {
          output: "ok",
          exitCode: 0,
        },
      },
      {
        type: "patch_summary",
        payload: {
          summary: "1 modified",
        },
      },
      { type: "assistant_message_start" },
      { type: "reasoning_end" },
    ]);
  });

  it("can opt into partial reply deltas when a plugin wants them on the activity stream", async () => {
    const onEvent = vi.fn();
    const callbacks = createReplyActivityCallbacks({
      onEvent,
      includePartialReplies: true,
    });

    await callbacks.onPartialReply?.({ text: "Partial answer" });

    expect(onEvent).toHaveBeenCalledWith({
      type: "partial_reply",
      payload: { text: "Partial answer" },
    });
  });
});

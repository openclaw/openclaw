import { describe, expect, it, vi } from "vitest";
import {
  createCompletionTruthPublicHostHook,
  createOnToolResultForwarder,
  resolveCompletionTruthFromPublicHost,
} from "../completion-truth.js";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

describe("sessions_yield tool", () => {
  it("returns error when no sessionId is provided", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ onYield });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "No session context",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("invokes onYield callback with default message", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      onYield,
    });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "yielded",
      message: "Turn yielded.",
    });
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.");
  });

  it("forwards an explicit completion truth envelope before yielding", async () => {
    const calls: string[] = [];
    const onYield = vi.fn(() => {
      calls.push("yield");
    });
    const onCompletionTruth = vi.fn(() => {
      calls.push("completion");
    });
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      onYield,
      onCompletionTruth,
    });

    await tool.execute("call-1", { message: "Waiting for fact-checker" });

    expect(calls).toEqual(["completion", "yield"]);
    expect(onCompletionTruth).toHaveBeenCalledWith({
      source: "sessions_yield",
      status: "yielded",
      message: "Waiting for fact-checker",
      sessionId: "test-session",
      toolCallId: "call-1",
    });
  });

  it("keeps yielding when completion truth observer fails", async () => {
    for (const onCompletionTruth of [
      vi.fn(async () => {
        throw new Error("observer async failed");
      }),
      vi.fn(() => {
        throw new Error("observer sync failed");
      }),
    ]) {
      const onYield = vi.fn();
      const tool = createSessionsYieldTool({
        sessionId: "test-session",
        onYield,
        onCompletionTruth,
      });

      const result = await tool.execute("call-1", { message: "Keep yielding" });

      expect(result.details).toMatchObject({
        status: "yielded",
        message: "Keep yielding",
      });
      expect(onCompletionTruth).toHaveBeenCalledOnce();
      expect(onYield).toHaveBeenCalledOnce();
      expect(onYield).toHaveBeenCalledWith("Keep yielding");
    }
  });

  it("real tool execution resolves completion truth from toolResult", async () => {
    const hook = createCompletionTruthPublicHostHook();
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      onYield,
      onCompletionTruth: createOnToolResultForwarder(hook),
    });

    await tool.execute("call-1", { message: "Waiting for worker" });

    await expect(
      resolveCompletionTruthFromPublicHost({
        hook,
        parseRealtimeHint: (rawMessage) => ({
          source: "sessions_yield",
          status: "yielded",
          message: rawMessage,
          sessionId: "test-session",
          toolCallId: "unknown",
        }),
        timeoutMs: 100,
        waitPolicy: { toolResultPriorityWindowMs: 10 },
      }),
    ).resolves.toMatchObject({
      output: {
        source: "sessions_yield",
        status: "yielded",
        message: "Waiting for worker",
        sessionId: "test-session",
        toolCallId: "call-1",
      },
      selection: {
        source: "toolResult",
        confidence: "high",
      },
    });
  });

  it("passes the custom message through the yield callback", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      onYield,
    });
    const result = await tool.execute("call-1", {
      message: "Waiting for fact-checker",
    });
    expect(result.details).toMatchObject({
      status: "yielded",
      message: "Waiting for fact-checker",
    });
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Waiting for fact-checker");
  });

  it("returns error without onYield callback", async () => {
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({
      status: "error",
      error: "Yield not supported in this context",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createContinueWorkTool, type ContinueWorkRequest } from "./continue-work-tool.js";

describe("continue_work tool", () => {
  function makeTool(
    overrides?: Partial<{
      agentSessionKey: string | undefined;
      requestContinuation: (request: ContinueWorkRequest) => void;
    }>,
  ) {
    return createContinueWorkTool({
      agentSessionKey: "test-session",
      requestContinuation: vi.fn(),
      ...overrides,
    });
  }

  it("schedules another turn with the default delay and forwards the reason", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-1", {
        reason: "Need one more turn to finish the summary.",
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Need one more turn to finish the summary.",
      delaySeconds: 0,
    });
    expect(result).toEqual({
      status: "scheduled",
      delaySeconds: 0,
    });
  });

  it("honors an explicit delaySeconds value", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-2", {
        reason: "Wait for the background write to settle.",
        delaySeconds: 15,
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Wait for the background write to settle.",
      delaySeconds: 15,
    });
    expect(result).toEqual({
      status: "scheduled",
      delaySeconds: 15,
    });
  });

  it("accepts string-encoded delaySeconds values", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-delay-string", {
        reason: "Wait for the background write to settle.",
        delaySeconds: "5",
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Wait for the background write to settle.",
      delaySeconds: 5,
    });
    expect(result).toEqual({
      status: "scheduled",
      delaySeconds: 5,
    });
  });

  it("requires a reason", async () => {
    const tool = makeTool();
    await expect(tool.execute("call-3", {})).rejects.toThrow(/reason required/i);
  });

  it("requires an active session", async () => {
    const tool = makeTool({ agentSessionKey: undefined });
    await expect(tool.execute("call-4", { reason: "Need another turn" })).rejects.toThrow(
      /requires an active session/i,
    );
  });
});

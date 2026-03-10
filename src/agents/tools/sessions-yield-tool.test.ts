import { describe, expect, it, vi } from "vitest";
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
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({ status: "yielded", message: "Turn yielded." });
    expect(onYield).toHaveBeenCalledOnce();
  });

  it("custom message appears in result but callback takes no args", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", { message: "Waiting for fact-checker" });
    expect(result.details).toMatchObject({
      status: "yielded",
      message: "Waiting for fact-checker",
    });
    expect(onYield).toHaveBeenCalledOnce();
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

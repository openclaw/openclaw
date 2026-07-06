// sleep tool tests cover duration validation, wake scheduling, and yield behavior.
import { describe, expect, it, vi } from "vitest";
import { createSleepTool } from "./sleep-tool.js";

type SleepDetails = {
  status?: string;
  message?: string;
  error?: string;
  seconds?: number;
};

describe("sleep tool", () => {
  it("returns error when no sessionId is provided", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ onYield, scheduleWake });
    const result = await tool.execute("call-1", {});
    const details = result.details as SleepDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("No session context");
    expect(onYield).not.toHaveBeenCalled();
    expect(scheduleWake).not.toHaveBeenCalled();
  });

  it("returns error without onYield callback", async () => {
    const tool = createSleepTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", { seconds: 60 });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("Yield not supported in this context");
  });

  it("rejects sleep duration over 600 seconds", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ sessionId: "test-session", onYield, scheduleWake });
    const result = await tool.execute("call-1", { seconds: 700 });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("600");
    expect(onYield).not.toHaveBeenCalled();
    expect(scheduleWake).not.toHaveBeenCalled();
  });

  it("rejects sleep duration under 1 second", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ sessionId: "test-session", onYield, scheduleWake });
    const result = await tool.execute("call-1", { seconds: 0 });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("at least 1");
  });

  it("schedules wake event then yields for valid duration", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ sessionId: "test-session", onYield, scheduleWake });
    const result = await tool.execute("call-1", { seconds: 300 });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("yielded");
    expect(details.seconds).toBe(300);
    expect(scheduleWake).toHaveBeenCalledOnce();
    expect(scheduleWake).toHaveBeenCalledWith(300, expect.stringContaining("Sleep timer fired"));
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith(expect.stringContaining("300s"));
  });

  it("passes custom message through to wake and yield", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ sessionId: "test-session", onYield, scheduleWake });
    const result = await tool.execute("call-1", {
      seconds: 60,
      message: "Check Planclave session 33e6da31",
    });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("yielded");
    expect(scheduleWake).toHaveBeenCalledWith(60, "Check Planclave session 33e6da31");
    expect(onYield).toHaveBeenCalledWith(
      expect.stringContaining("Check Planclave session 33e6da31"),
    );
  });

  it("works without scheduleWake callback (testing mode)", async () => {
    const onYield = vi.fn();
    const tool = createSleepTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", { seconds: 30 });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("yielded");
    expect(onYield).toHaveBeenCalledOnce();
  });

  it("defaults to 60 seconds when seconds not provided", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ sessionId: "test-session", onYield, scheduleWake });
    await tool.execute("call-1", {});
    expect(scheduleWake).toHaveBeenCalledWith(60, expect.any(String));
  });
});

// Sleep tool tests cover duration validation, wake scheduling, and yield behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayCallOptions } from "./gateway.js";
import { createSleepTool, scheduleSleepWake } from "./sleep-tool.js";

type SleepDetails = {
  status?: string;
  message?: string;
  error?: string;
  seconds?: number;
};

describe("sleep tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("advertises seconds as optional with a 60-second default", () => {
    const tool = createSleepTool();
    const schema = tool.parameters as {
      properties?: { seconds?: { default?: number } };
      required?: string[];
    };
    expect(schema.properties?.seconds?.default).toBe(60);
    expect(schema.required ?? []).not.toContain("seconds");
  });

  it("returns error when no sessionKey is provided", async () => {
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
    const tool = createSleepTool({ sessionKey: "test-session" });
    const result = await tool.execute("call-1", { seconds: 60 });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("Yield not supported in this context");
  });

  it("rejects sleep duration over 600 seconds", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ sessionKey: "test-session", onYield, scheduleWake });
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
    const tool = createSleepTool({ sessionKey: "test-session", onYield, scheduleWake });
    const result = await tool.execute("call-1", { seconds: 0 });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("at least 1");
  });

  it("schedules wake event then yields for valid duration", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ sessionKey: "test-session", onYield, scheduleWake });
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
    const tool = createSleepTool({ sessionKey: "test-session", onYield, scheduleWake });
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

  it("does not yield without a wake scheduler", async () => {
    const onYield = vi.fn();
    const tool = createSleepTool({ sessionKey: "test-session", onYield });
    const result = await tool.execute("call-1", { seconds: 30 });
    const details = result.details as SleepDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("Wake scheduling");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("defaults to 60 seconds when seconds not provided", async () => {
    const onYield = vi.fn();
    const scheduleWake = vi.fn();
    const tool = createSleepTool({ sessionKey: "test-session", onYield, scheduleWake });
    await tool.execute("call-1", {});
    expect(scheduleWake).toHaveBeenCalledWith(60, expect.any(String));
  });

  it("schedules wake before yielding (order matters)", async () => {
    const callOrder: string[] = [];
    const onYield = vi.fn(() => {
      callOrder.push("yield");
    });
    const scheduleWake = vi.fn(() => {
      callOrder.push("schedule");
    });
    const tool = createSleepTool({ sessionKey: "test-session", onYield, scheduleWake });
    await tool.execute("call-1", { seconds: 10 });
    expect(callOrder).toEqual(["schedule", "yield"]);
  });

  it("schedules a scoped transient wake with the caller tool surface", async () => {
    const callGateway = vi.fn(async () => ({}));

    await scheduleSleepWake({
      seconds: 10,
      message: "Resume pending work",
      sessionKey: "agent:main:session-1",
      creatorToolAllowlist: ["read", { name: "cron" }, "read"],
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledWith(
      "sleep.schedule",
      {},
      {
        seconds: 10,
        message: "Resume pending work",
        toolsAllow: ["read", "cron"],
        sessionKey: "agent:main:session-1",
      },
      { requireAgentRuntimeIdentity: true },
    );
  });

  it("leaves the wake unrestricted when the caller has no restrictive policy", async () => {
    const callGateway = vi.fn(
      async (_method: string, _opts: GatewayCallOptions, _params?: unknown) => ({}),
    );

    await scheduleSleepWake({
      seconds: 10,
      message: "Resume pending work",
      sessionKey: "agent:main:session-1",
      callGateway,
    });

    const params = callGateway.mock.calls[0]![2] as Record<string, unknown>;
    expect(params).not.toHaveProperty("toolsAllow");
  });
});

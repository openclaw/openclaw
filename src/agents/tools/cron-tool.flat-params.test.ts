import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import { createCronTool } from "./cron-tool.js";

describe("cron tool flat-params", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves explicit top-level sessionKey during flat-params recovery", async () => {
    const tool = createCronTool({ agentSessionKey: "agent:main:discord:channel:ops" });
    await tool.execute("call-flat-session-key", {
      action: "add",
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      message: "do stuff",
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { sessionKey?: string };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
  });

  it("rejects deleteAfterRun for recurring schedules", async () => {
    const tool = createCronTool();
    await expect(
      tool.execute("call-recurring-delete-after-run", {
        action: "add",
        job: {
          name: "bad-recurring-job",
          // Any positive everyMs would work here; 60_000 is a readable 1-minute sample.
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "ping" },
          deleteAfterRun: true,
        },
      }),
    ).rejects.toThrow('deleteAfterRun=true is only valid with schedule.kind="at"');

    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("rejects wrong absolute at when reminder text asks for short relative delay", async () => {
    const now = Date.parse("2026-02-17T06:38:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);

    const tool = createCronTool();
    await expect(
      tool.execute("call-relative-mismatch", {
        action: "add",
        job: {
          name: "remind-check-messages-1m",
          description: "1分钟后提醒看消息",
          schedule: { kind: "at", at: "2026-02-17T16:51:07.000Z" },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "⏰ 提醒：现在该看一下消息啦。" },
          deleteAfterRun: true,
        },
      }),
    ).rejects.toThrow("schedule.at mismatches explicit relative duration");
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("rejects one-shot relative reminders that are incorrectly generated as recurring", async () => {
    const tool = createCronTool();
    await expect(
      tool.execute("call-relative-every", {
        action: "add",
        job: {
          name: "remind-in-1-minute",
          description: "remind me in 1 minute",
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "reminder in 1 minute" },
        },
      }),
    ).rejects.toThrow('explicit relative reminder requires schedule.kind="at"');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("keeps recurring schedules when text clearly indicates recurring intent", async () => {
    const tool = createCronTool();
    await tool.execute("call-recurring-intent", {
      action: "add",
      job: {
        name: "hourly-check",
        description: "in 1 minute every day remind me to check messages",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "recurring reminder: check messages" },
        deleteAfterRun: false,
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: {
        schedule?: { kind?: string; everyMs?: number };
        deleteAfterRun?: boolean;
      };
    };
    expect(call.params?.schedule).toEqual({ kind: "every", everyMs: 60_000 });
    expect(call.params?.deleteAfterRun).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import { createCronTool } from "./cron-tool.js";

describe("cron tool flat-params", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  it("preserves explicit top-level sessionKey during flat-params recovery", async () => {
    const tool = createCronTool(
      { agentSessionKey: "agent:main:discord:channel:ops" },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-flat-session-key", {
      action: "add",
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      message: "do stuff",
    });

    const [method, _gatewayOpts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      { sessionKey?: string },
    ];
    expect(method).toBe("cron.add");
    expect(params.sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
  });

  it("reconstructs schedule from top-level every shorthand (#56996)", async () => {
    const tool = createCronTool({}, { callGatewayTool: callGatewayToolMock });
    await tool.execute("call-flat-every", {
      action: "add",
      name: "test",
      every: 300_000,
      message: "ping",
    });

    const [method, _opts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({ kind: "every", everyMs: 300_000 });
    expect(params.every).toBeUndefined();
  });

  it("reconstructs schedule from top-level cron shorthand", async () => {
    const tool = createCronTool({}, { callGatewayTool: callGatewayToolMock });
    await tool.execute("call-flat-cron", {
      action: "add",
      name: "daily",
      cron: "0 9 * * *",
      tz: "America/New_York",
      message: "morning check",
    });

    const [_method, _opts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(params.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "America/New_York" });
    expect(params.cron).toBeUndefined();
    expect(params.tz).toBeUndefined();
  });

  it("reconstructs schedule from top-level at shorthand", async () => {
    const tool = createCronTool({}, { callGatewayTool: callGatewayToolMock });
    await tool.execute("call-flat-at", {
      action: "add",
      name: "once",
      at: "2026-04-01T12:00:00Z",
      message: "reminder",
    });

    const [_method, _opts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(params.schedule).toEqual({ kind: "at", at: "2026-04-01T12:00:00.000Z" });
    expect(params.at).toBeUndefined();
  });

  it("coerces null job to undefined and triggers flat-params recovery", async () => {
    const tool = createCronTool({}, { callGatewayTool: callGatewayToolMock });
    await tool.execute("call-null-job", {
      action: "add",
      job: null,
      name: "test",
      every: 60_000,
      message: "ping",
    });

    const [method, _opts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(method).toBe("cron.add");
    expect(params.schedule).toEqual({ kind: "every", everyMs: 60_000 });
  });

  it("reconstructs schedule from everyMs shorthand", async () => {
    const tool = createCronTool({}, { callGatewayTool: callGatewayToolMock });
    await tool.execute("call-flat-everyMs", {
      action: "add",
      name: "test",
      everyMs: 120_000,
      message: "ping",
    });

    const [_method, _opts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(params.schedule).toEqual({ kind: "every", everyMs: 120_000 });
  });

  it("adds schedule shorthand keys for update flat-params recovery", async () => {
    const tool = createCronTool({}, { callGatewayTool: callGatewayToolMock });
    await tool.execute("call-flat-update", {
      action: "update",
      jobId: "job-1",
      every: 600_000,
    });

    const [method, _opts, params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      { id?: string; patch?: Record<string, unknown> },
    ];
    expect(method).toBe("cron.update");
    expect(params.patch?.schedule).toEqual({ kind: "every", everyMs: 600_000 });
  });
});

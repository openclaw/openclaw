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
});

describe("cron tool concatenated-key repair", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  it("repairs namePayload into name + payload for add", async () => {
    const tool = createCronTool(
      { agentSessionKey: "agent:main" },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-name-payload", {
      action: "add",
      job: {
        namePayload: { kind: "agentTurn", message: "test" },
        schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
        enabled: true,
      },
    });

    const [method, , params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      { payload: Record<string, unknown>; name: string },
    ];
    expect(method).toBe("cron.add");
    expect(params.payload).toBeDefined();
    expect(params.payload.kind).toBe("agentTurn");
    // namePayload should not leak through
    expect((params as Record<string, unknown>).namePayload).toBeUndefined();
  });

  it("repairs scheduleKind into schedule for add", async () => {
    const tool = createCronTool(
      { agentSessionKey: "agent:main" },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-schedule-kind", {
      action: "add",
      job: {
        name: "test-job",
        scheduleKind: { kind: "every", everyMs: 999999 },
        payload: { kind: "agentTurn", message: "test" },
      },
    });

    const [method, , params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      { schedule: Record<string, unknown> },
    ];
    expect(method).toBe("cron.add");
    expect(params.schedule).toBeDefined();
    expect(params.schedule.kind).toBe("every");
    expect((params as Record<string, unknown>).scheduleKind).toBeUndefined();
  });

  it("repairs sessionTargetName into sessionTarget + name for add", async () => {
    const tool = createCronTool(
      { agentSessionKey: "agent:main" },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-session-target-name", {
      action: "add",
      job: {
        sessionTargetName: "my-cron-job",
        schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
        payload: { kind: "agentTurn", message: "test" },
      },
    });

    const [method, , params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      { name: string },
    ];
    expect(method).toBe("cron.add");
    expect(params.name).toBe("my-cron-job");
    expect((params as Record<string, unknown>).sessionTargetName).toBeUndefined();
  });

  it("repairs concatenated keys in patch for update", async () => {
    const tool = createCronTool(
      { agentSessionKey: "agent:main" },
      { callGatewayTool: callGatewayToolMock },
    );
    await tool.execute("call-update-concat", {
      action: "update",
      jobId: "job-123",
      patch: {
        namePayload: { kind: "agentTurn", message: "updated" },
      },
    });

    const [method, , params] = callGatewayToolMock.mock.calls[0] as [
      string,
      unknown,
      { patch: Record<string, unknown> },
    ];
    expect(method).toBe("cron.update");
    expect(params.patch.payload).toBeDefined();
    expect(params.patch.namePayload).toBeUndefined();
  });
});

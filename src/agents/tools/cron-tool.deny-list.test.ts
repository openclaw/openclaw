import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock, loadConfigMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadConfigMock: vi.fn(() => ({})),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "main",
}));

import { createCronTool } from "./cron-tool.js";

describe("cron tool deny list enforcement (#46635)", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({ ok: true });
    loadConfigMock.mockClear();
  });

  it("blocks execution when agent tools.deny includes cron", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              deny: ["cron"],
            },
          },
        ],
      },
    });

    const tool = createCronTool({ agentSessionKey: "agent:main:main" });
    await expect(tool.execute("call-1", { action: "status" })).rejects.toThrow("CRON_TOOL_DENIED");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("blocks execution when global tools.deny includes cron", async () => {
    loadConfigMock.mockReturnValue({
      tools: {
        deny: ["cron"],
      },
    });

    const tool = createCronTool({ agentSessionKey: "agent:main:main" });
    await expect(tool.execute("call-1", { action: "list" })).rejects.toThrow("CRON_TOOL_DENIED");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows execution when cron is not in deny list", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              deny: ["subagents"],
            },
          },
        ],
      },
    });

    const tool = createCronTool({ agentSessionKey: "agent:main:main" });
    await tool.execute("call-1", { action: "status" });
    expect(callGatewayMock).toHaveBeenCalled();
  });

  it("blocks cron add when agent deny list includes cron", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              deny: ["cron", "subagents"],
            },
          },
        ],
      },
    });

    const tool = createCronTool({ agentSessionKey: "agent:main:main" });
    await expect(
      tool.execute("call-1", {
        action: "add",
        job: {
          name: "test",
          schedule: { kind: "at", at: new Date().toISOString() },
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    ).rejects.toThrow("CRON_TOOL_DENIED");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows execution when no config deny lists are present", async () => {
    loadConfigMock.mockReturnValue({});

    const tool = createCronTool({ agentSessionKey: "agent:main:main" });
    await tool.execute("call-1", { action: "status" });
    expect(callGatewayMock).toHaveBeenCalled();
  });
});

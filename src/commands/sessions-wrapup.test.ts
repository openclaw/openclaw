import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  agentViaGatewayCommand: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("./agent-via-gateway.js", () => ({
  agentViaGatewayCommand: mocks.agentViaGatewayCommand,
}));

import { sessionsWrapupCommand } from "./sessions-wrapup.js";

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
  };
}

describe("sessionsWrapupCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentViaGatewayCommand.mockResolvedValue(undefined);
  });

  it("sends /new summary to gateway for the selected agent", async () => {
    const runtime = makeRuntime();

    await sessionsWrapupCommand(
      {
        agent: "main",
        summary: "carry over this context",
        timeout: "30",
        json: true,
      },
      runtime,
    );

    expect(mocks.agentViaGatewayCommand).toHaveBeenCalledWith(
      {
        agent: "main",
        message: "/new carry over this context",
        json: true,
        timeout: "30",
      },
      runtime,
    );
  });

  it("uses default agent when --agent is omitted", async () => {
    const runtime = makeRuntime();

    await sessionsWrapupCommand({ summary: "hello" }, runtime);

    expect(mocks.resolveDefaultAgentId).toHaveBeenCalled();
    expect(mocks.agentViaGatewayCommand).toHaveBeenCalledWith(
      {
        agent: "main",
        message: "/new hello",
        json: false,
        timeout: undefined,
      },
      runtime,
    );
  });

  it("requires --summary", async () => {
    const runtime = makeRuntime();

    await expect(sessionsWrapupCommand({ summary: "  " }, runtime)).rejects.toThrow("exit 1");
    expect(runtime.error).toHaveBeenCalledWith("--summary is required");
    expect(mocks.agentViaGatewayCommand).not.toHaveBeenCalled();
  });
});

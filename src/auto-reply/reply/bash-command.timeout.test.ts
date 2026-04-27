import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

const { createExecToolMock, executeMock, getSessionMock, getFinishedSessionMock } = vi.hoisted(
  () => ({
    createExecToolMock: vi.fn(),
    executeMock: vi.fn(),
    getSessionMock: vi.fn(),
    getFinishedSessionMock: vi.fn(),
  }),
);

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "agent:main"),
}));

vi.mock("../../agents/bash-process-registry.js", () => ({
  getSession: getSessionMock,
  getFinishedSession: getFinishedSessionMock,
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: createExecToolMock,
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

const { handleBashChatCommand } = await import("./bash-command.js");

function buildParams(commandBody: string, cfg?: OpenClawConfig) {
  return {
    ctx: {
      CommandBody: commandBody,
      SessionKey: "agent:main:main",
    } as MsgContext,
    cfg: cfg ?? ({ commands: { bash: true } } as OpenClawConfig),
    sessionKey: "agent:main:main",
    isGroup: false,
    elevated: {
      enabled: true,
      allowed: true,
      failures: [],
    },
  };
}

describe("handleBashChatCommand timeout handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      details: {
        status: "completed",
        exitCode: 0,
        durationMs: 1,
        aggregated: "done",
      },
    });
    createExecToolMock.mockReturnValue({ execute: executeMock });
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);
  });

  it("disables the exec timeout for chat bash jobs when no timeout is configured", async () => {
    await handleBashChatCommand(buildParams("/bash tail -f app.log"));

    expect(executeMock).toHaveBeenCalledWith("chat-bash", expect.objectContaining({ timeout: 0 }));
  });

  it("preserves configured exec timeouts for chat bash jobs", async () => {
    await handleBashChatCommand(
      buildParams("/bash tail -f app.log", {
        commands: { bash: true },
        tools: { exec: { timeoutSec: 45 } },
      } as OpenClawConfig),
    );

    expect(executeMock).toHaveBeenCalledWith("chat-bash", expect.objectContaining({ timeout: 45 }));
  });

  it("shows timeout exit reasons when polling finished chat bash jobs", async () => {
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue({
      id: "bash-session-1",
      scopeKey: "chat:bash",
      status: "failed",
      exitCode: null,
      exitSignal: null,
      exitReason: "overall-timeout",
      aggregated: "Command timed out after 30 seconds.",
      tail: "Command timed out after 30 seconds.",
      truncated: false,
      startedAt: 123,
      endedAt: 456,
      totalOutputChars: 0,
      command: "tail -f app.log",
    });

    const result = await handleBashChatCommand(buildParams("/bash poll bash-session-1"));

    expect(result.text).toContain("Exit: timeout");
    expect(result.text).not.toContain("Exit: code 0");
  });
});

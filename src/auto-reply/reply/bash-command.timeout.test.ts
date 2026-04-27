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

  it("uses the configured exec default timeout when no chat bash timeout is configured", async () => {
    await handleBashChatCommand(buildParams("/bash tail -f app.log"));

    expect(executeMock).toHaveBeenCalledWith(
      "chat-bash",
      expect.objectContaining({ timeout: undefined }),
    );
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

  it("allows chat bash jobs to disable the exec timeout", async () => {
    await handleBashChatCommand(buildParams("/bash timeout=0 tail -f app.log"));

    expect(executeMock).toHaveBeenCalledWith("chat-bash", {
      command: "tail -f app.log",
      background: false,
      yieldMs: 2000,
      timeout: 0,
      elevated: true,
    });
  });

  it("allows chat bash jobs to override the exec timeout with a flag", async () => {
    await handleBashChatCommand(buildParams("/bash --timeout 90 npm test"));

    expect(executeMock).toHaveBeenCalledWith(
      "chat-bash",
      expect.objectContaining({ command: "npm test", timeout: 90 }),
    );
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
      failureReason: "Command timed out after 30 seconds.",
      aggregated: "",
      tail: "",
      truncated: false,
      startedAt: 123,
      endedAt: 456,
      totalOutputChars: 0,
      command: "tail -f app.log",
    });

    const result = await handleBashChatCommand(buildParams("/bash poll bash-session-1"));

    expect(result.text).toContain("Exit: timeout");
    expect(result.text).toContain("Command timed out after 30 seconds.");
    expect(result.text).not.toContain("Exit: code 0");
  });

  it("keeps captured output visible when polling timed-out chat bash jobs", async () => {
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue({
      id: "bash-session-2",
      scopeKey: "chat:bash",
      status: "failed",
      exitCode: null,
      exitSignal: null,
      exitReason: "overall-timeout",
      failureReason: "Command timed out after 30 seconds.",
      aggregated: "server started\nlast log line",
      tail: "last log line",
      truncated: false,
      startedAt: 123,
      endedAt: 456,
      totalOutputChars: 28,
      command: "npm run dev",
    });

    const result = await handleBashChatCommand(buildParams("/bash poll bash-session-2"));

    expect(result.text).toContain("server started");
    expect(result.text).toContain("last log line");
    expect(result.text).toContain("Command timed out after 30 seconds.");
  });
});

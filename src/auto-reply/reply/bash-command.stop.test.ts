import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

const { getSessionMock, getFinishedSessionMock, markExitedMock, killProcessTreeMock } = vi.hoisted(
  () => ({
    getSessionMock: vi.fn(),
    getFinishedSessionMock: vi.fn(),
    markExitedMock: vi.fn(),
    killProcessTreeMock: vi.fn(),
  }),
);

vi.mock("../../agents/bash-process-registry.js", () => ({
  getSession: getSessionMock,
  getFinishedSession: getFinishedSessionMock,
  markExited: markExitedMock,
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

const { handleBashChatCommand, BASH_STOP_CONFIRM_DELAY_MS } = await import("./bash-command.js");

function buildParams(commandBody: string) {
  const cfg = {
    commands: { bash: true },
  } as OpenClawConfig;

  const ctx = {
    CommandBody: commandBody,
    SessionKey: "session-key",
  } as MsgContext;

  return {
    ctx,
    cfg,
    sessionKey: "session-key",
    isGroup: false,
    elevated: {
      enabled: true,
      allowed: true,
      failures: [],
    },
  };
}

function buildRunningSession(overrides?: Record<string, unknown>) {
  return {
    id: "session-1",
    scopeKey: "chat:bash",
    backgrounded: true,
    pid: 4242,
    startedAt: Date.now(),
    tail: "",
    ...overrides,
  };
}

describe("handleBashChatCommand stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSessionMock.mockReset();
    getFinishedSessionMock.mockReset();
    markExitedMock.mockReset();
    killProcessTreeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not report stopped or mark exited until after the confirm delay", async () => {
    const session = buildRunningSession();
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const pending = handleBashChatCommand(buildParams("/bash stop session-1"));

    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });

    // Advance to just before the delay expires.
    await vi.advanceTimersByTimeAsync(BASH_STOP_CONFIRM_DELAY_MS - 1);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(markExitedMock).not.toHaveBeenCalled();

    // Let the delay expire.
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result.text).toContain("bash stopped");
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
    expect(markExitedMock).toHaveBeenCalledTimes(1);
    expect(markExitedMock).toHaveBeenCalledWith(session, null, "SIGKILL", "failed");
  });

  it("returns no-running-job when session is not found", async () => {
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("No running bash job found");
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(markExitedMock).not.toHaveBeenCalled();
  });

  it("skips killProcessTree when session has no pid", async () => {
    const session = buildRunningSession({ pid: undefined, child: undefined });
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const pending = handleBashChatCommand(buildParams("/bash stop session-1"));
    await vi.advanceTimersByTimeAsync(BASH_STOP_CONFIRM_DELAY_MS + 1);
    const result = await pending;

    expect(result.text).toContain("bash stopped");
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(markExitedMock).toHaveBeenCalledWith(session, null, "SIGKILL", "failed");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { handleStopCommand } from "./commands-session.js";

// Mock dependencies
vi.mock("../../agents/bash-process-registry.js", () => ({
  listAllRunningSessions: vi.fn(() => []),
}));

vi.mock("../../agents/shell-utils.js", () => ({
  killProcessTree: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(() => true),
}));

vi.mock("./queue.js", () => ({
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
}));

vi.mock("./abort.js", () => ({
  stopSubagentsForRequester: vi.fn(() => ({ stopped: 0 })),
  formatAbortReplyText: vi.fn(() => "⚙️ Agent was aborted."),
  setAbortMemory: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(),
}));

describe("handleStopCommand with process killing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kills exec sessions matching sessionKey", async () => {
    const { listAllRunningSessions } = await import("../../agents/bash-process-registry.js");
    const { killProcessTree } = await import("../../agents/shell-utils.js");

    // Mock running exec sessions
    vi.mocked(listAllRunningSessions).mockReturnValue([
      {
        id: "session-1",
        sessionKey: "agent:main:telegram:12345",
        pid: 1001,
        command: "bsp process file1.pdf",
        startedAt: Date.now(),
        cwd: "/workspace",
        maxOutputChars: 10000,
        totalOutputChars: 0,
        pendingStdout: [],
        pendingStderr: [],
        pendingStdoutChars: 0,
        pendingStderrChars: 0,
        aggregated: "",
        tail: "",
        exited: false,
        truncated: false,
        backgrounded: true,
      },
      {
        id: "session-2",
        sessionKey: "agent:main:telegram:99999", // Different session
        pid: 1002,
        command: "bsp process file2.pdf",
        startedAt: Date.now(),
        cwd: "/workspace",
        maxOutputChars: 10000,
        totalOutputChars: 0,
        pendingStdout: [],
        pendingStderr: [],
        pendingStdoutChars: 0,
        pendingStderrChars: 0,
        aggregated: "",
        tail: "",
        exited: false,
        truncated: false,
        backgrounded: true,
      },
    ]);

    const params: HandleCommandsParams = {
      command: {
        commandBodyNormalized: "/stop",
        rawBodyNormalized: "/stop",
        isAuthorizedSender: true,
        senderId: "user123",
        surface: "telegram",
        channel: "telegram",
        from: "user123",
        to: "bot",
      },
      sessionKey: "agent:main:telegram:12345",
      sessionEntry: {
        sessionId: "sess-abc",
        sessionKey: "agent:main:telegram:12345",
      } as SessionEntry,
      sessionStore: {},
      cfg: {} as OpenClawConfig,
      ctx: {},
      isGroup: false,
    };

    const result = await handleStopCommand(params, true);

    expect(result).toBeDefined();
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("⚙️ Agent was aborted.");

    // Verify killProcessTree was called only for matching session's pid
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(killProcessTree).toHaveBeenCalledWith(1001);
  });

  it("kills non-backgrounded exec sessions too", async () => {
    const { listAllRunningSessions } = await import("../../agents/bash-process-registry.js");
    const { killProcessTree } = await import("../../agents/shell-utils.js");

    vi.mocked(listAllRunningSessions).mockReturnValue([
      {
        id: "fg-session",
        sessionKey: "agent:main:telegram:12345",
        pid: 2001,
        command: "python train.py",
        startedAt: Date.now(),
        cwd: "/workspace",
        maxOutputChars: 10000,
        totalOutputChars: 0,
        pendingStdout: [],
        pendingStderr: [],
        pendingStdoutChars: 0,
        pendingStderrChars: 0,
        aggregated: "",
        tail: "",
        exited: false,
        truncated: false,
        backgrounded: false, // NOT backgrounded — should still be killed
      },
    ]);

    const params: HandleCommandsParams = {
      command: {
        commandBodyNormalized: "/stop",
        rawBodyNormalized: "/stop",
        isAuthorizedSender: true,
        senderId: "user123",
        surface: "telegram",
        channel: "telegram",
        from: "user123",
        to: "bot",
      },
      sessionKey: "agent:main:telegram:12345",
      sessionEntry: {
        sessionId: "sess-abc",
        sessionKey: "agent:main:telegram:12345",
      } as SessionEntry,
      sessionStore: {},
      cfg: {} as OpenClawConfig,
      ctx: {},
      isGroup: false,
    };

    await handleStopCommand(params, true);

    // Non-backgrounded sessions should now be killed too
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(killProcessTree).toHaveBeenCalledWith(2001);
  });

  it("does not kill processes when sessionKey is undefined", async () => {
    const { listAllRunningSessions } = await import("../../agents/bash-process-registry.js");
    const { killProcessTree } = await import("../../agents/shell-utils.js");

    vi.mocked(listAllRunningSessions).mockReturnValue([
      {
        id: "session-1",
        sessionKey: "agent:main:telegram:12345",
        pid: 1001,
        command: "bsp process file.pdf",
        startedAt: Date.now(),
        cwd: "/workspace",
        maxOutputChars: 10000,
        totalOutputChars: 0,
        pendingStdout: [],
        pendingStderr: [],
        pendingStdoutChars: 0,
        pendingStderrChars: 0,
        aggregated: "",
        tail: "",
        exited: false,
        truncated: false,
        backgrounded: true,
      },
    ]);

    const params: HandleCommandsParams = {
      command: {
        commandBodyNormalized: "/stop",
        rawBodyNormalized: "/stop",
        isAuthorizedSender: true,
        senderId: "user123",
        surface: "telegram",
        channel: "telegram",
        from: "user123",
        to: "bot",
      },
      sessionKey: undefined, // No session key
      sessionEntry: undefined,
      sessionStore: {},
      cfg: {} as OpenClawConfig,
      ctx: {},
      isGroup: false,
    };

    await handleStopCommand(params, true);

    // Should not attempt to kill any processes
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it("blocks unauthorized users from using /stop", async () => {
    const { killProcessTree } = await import("../../agents/shell-utils.js");

    const params: HandleCommandsParams = {
      command: {
        commandBodyNormalized: "/stop",
        rawBodyNormalized: "/stop",
        isAuthorizedSender: false, // Unauthorized
        senderId: "hacker123",
        surface: "telegram",
        channel: "telegram",
        from: "hacker123",
        to: "bot",
      },
      sessionKey: "agent:main:telegram:12345",
      sessionEntry: {} as SessionEntry,
      sessionStore: {},
      cfg: {} as OpenClawConfig,
      ctx: {},
      isGroup: false,
    };

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(killProcessTree).not.toHaveBeenCalled();
  });
});

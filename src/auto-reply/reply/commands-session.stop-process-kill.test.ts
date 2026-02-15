import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { handleStopCommand } from "./commands-session.js";

// Mock dependencies
vi.mock("../../agents/bash-process-registry.js", () => ({
  listRunningSessions: vi.fn(() => []),
}));

vi.mock("../../agents/bash-tools.shared.js", () => ({
  killSession: vi.fn(),
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
    const { listRunningSessions } = await import("../../agents/bash-process-registry.js");
    const { killSession } = await import("../../agents/bash-tools.shared.js");

    // Mock running exec sessions
    vi.mocked(listRunningSessions).mockReturnValue([
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

    // Verify killSession was called only for matching session
    expect(killSession).toHaveBeenCalledTimes(1);
    expect(killSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        sessionKey: "agent:main:telegram:12345",
        pid: 1001,
      }),
    );
  });

  it("does not kill processes when sessionKey is undefined", async () => {
    const { listRunningSessions } = await import("../../agents/bash-process-registry.js");
    const { killSession } = await import("../../agents/bash-tools.shared.js");

    vi.mocked(listRunningSessions).mockReturnValue([
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
    expect(killSession).not.toHaveBeenCalled();
  });

  it("blocks unauthorized users from using /stop", async () => {
    const { killSession } = await import("../../agents/bash-tools.shared.js");

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
    expect(killSession).not.toHaveBeenCalled();
  });
});

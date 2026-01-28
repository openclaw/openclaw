import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import workspaceSyncHandler from "./handler.js";
import * as rclone from "../../../infra/rclone.js";

vi.mock("../../../infra/rclone.js", () => ({
  isRcloneInstalled: vi.fn(),
  isRcloneConfigured: vi.fn(),
  resolveSyncConfig: vi.fn(),
  runBisync: vi.fn(),
}));

vi.mock("../../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
}));

vi.mock("../../../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: vi.fn(() => "default"),
}));

describe("workspace-sync hook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores non-session events", async () => {
    const event = {
      type: "command",
      action: "new",
      sessionKey: "test-session",
      context: {},
    };

    await workspaceSyncHandler(event as never);

    expect(rclone.isRcloneInstalled).not.toHaveBeenCalled();
  });

  it("ignores session events when sync is not configured", async () => {
    const event = {
      type: "session",
      action: "start",
      sessionKey: "test-session",
      context: { cfg: {} },
    };

    await workspaceSyncHandler(event as never);

    expect(rclone.isRcloneInstalled).not.toHaveBeenCalled();
  });

  it("ignores session start when onSessionStart is false", async () => {
    const event = {
      type: "session",
      action: "start",
      sessionKey: "test-session",
      context: {
        cfg: {
          workspace: {
            sync: {
              provider: "dropbox",
              remotePath: "moltbot-share",
              onSessionStart: false,
              onSessionEnd: true,
            },
          },
        },
      },
    };

    await workspaceSyncHandler(event as never);

    expect(rclone.isRcloneInstalled).not.toHaveBeenCalled();
  });

  it("ignores session end when onSessionEnd is false", async () => {
    const event = {
      type: "session",
      action: "end",
      sessionKey: "test-session",
      context: {
        cfg: {
          workspace: {
            sync: {
              provider: "dropbox",
              remotePath: "moltbot-share",
              onSessionStart: true,
              onSessionEnd: false,
            },
          },
        },
      },
    };

    await workspaceSyncHandler(event as never);

    expect(rclone.isRcloneInstalled).not.toHaveBeenCalled();
  });

  it("ignores provider: off", async () => {
    const event = {
      type: "session",
      action: "start",
      sessionKey: "test-session",
      context: {
        cfg: {
          workspace: {
            sync: {
              provider: "off",
              remotePath: "moltbot-share",
              onSessionStart: true,
            },
          },
        },
      },
    };

    await workspaceSyncHandler(event as never);

    expect(rclone.isRcloneInstalled).not.toHaveBeenCalled();
  });

  it("warns when rclone is not installed", async () => {
    vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = {
      type: "session",
      action: "start",
      sessionKey: "test-session",
      context: {
        cfg: {
          workspace: {
            sync: {
              provider: "dropbox",
              remotePath: "moltbot-share",
              onSessionStart: true,
            },
          },
        },
      },
    };

    await workspaceSyncHandler(event as never);

    expect(rclone.isRcloneInstalled).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[workspace-sync] rclone not installed, skipping sync");
  });

  it("warns when rclone is not configured", async () => {
    vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
    vi.mocked(rclone.isRcloneConfigured).mockReturnValue(false);
    vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
      provider: "dropbox",
      remoteName: "cloud",
      remotePath: "moltbot-share",
      localPath: "/workspace/shared",
      configPath: "/home/.config/rclone/rclone.conf",
      conflictResolve: "newer",
      exclude: [],
      interval: 0,
      onSessionStart: true,
      onSessionEnd: false,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = {
      type: "session",
      action: "start",
      sessionKey: "test-session",
      context: {
        cfg: {
          workspace: {
            sync: {
              provider: "dropbox",
              remotePath: "moltbot-share",
              onSessionStart: true,
            },
          },
        },
      },
    };

    await workspaceSyncHandler(event as never);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rclone not configured for remote "cloud"'),
    );
  });

  it("runs bisync on session start when configured", async () => {
    vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
    vi.mocked(rclone.isRcloneConfigured).mockReturnValue(true);
    vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
      provider: "dropbox",
      remoteName: "cloud",
      remotePath: "moltbot-share",
      localPath: "/workspace/shared",
      configPath: "/home/.config/rclone/rclone.conf",
      conflictResolve: "newer",
      exclude: [".git/**"],
      interval: 0,
      onSessionStart: true,
      onSessionEnd: false,
    });
    vi.mocked(rclone.runBisync).mockResolvedValue({ ok: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const event = {
      type: "session",
      action: "start",
      sessionKey: "test-session",
      context: {
        cfg: {
          workspace: {
            sync: {
              provider: "dropbox",
              remotePath: "moltbot-share",
              onSessionStart: true,
            },
          },
        },
      },
    };

    await workspaceSyncHandler(event as never);

    expect(rclone.runBisync).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteName: "cloud",
        remotePath: "moltbot-share",
        localPath: "/workspace/shared",
        conflictResolve: "newer",
      }),
    );
  });

  it("handles session stop as end event", async () => {
    vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
    vi.mocked(rclone.isRcloneConfigured).mockReturnValue(true);
    vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
      provider: "dropbox",
      remoteName: "cloud",
      remotePath: "moltbot-share",
      localPath: "/workspace/shared",
      configPath: "/home/.config/rclone/rclone.conf",
      conflictResolve: "newer",
      exclude: [],
      interval: 0,
      onSessionStart: false,
      onSessionEnd: true,
    });
    vi.mocked(rclone.runBisync).mockResolvedValue({ ok: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const event = {
      type: "session",
      action: "stop",
      sessionKey: "test-session",
      context: {
        cfg: {
          workspace: {
            sync: {
              provider: "dropbox",
              remotePath: "moltbot-share",
              onSessionEnd: true,
            },
          },
        },
      },
    };

    await workspaceSyncHandler(event as never);

    expect(rclone.runBisync).toHaveBeenCalled();
  });

  it("warns about --resync on first run error", async () => {
    vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
    vi.mocked(rclone.isRcloneConfigured).mockReturnValue(true);
    vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
      provider: "dropbox",
      remoteName: "cloud",
      remotePath: "moltbot-share",
      localPath: "/workspace/shared",
      configPath: "/home/.config/rclone/rclone.conf",
      conflictResolve: "newer",
      exclude: [],
      interval: 0,
      onSessionStart: true,
      onSessionEnd: false,
    });
    vi.mocked(rclone.runBisync).mockResolvedValue({
      ok: false,
      error: "bisync requires --resync on first run",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = {
      type: "session",
      action: "start",
      sessionKey: "test-session",
      context: {
        cfg: {
          workspace: {
            sync: {
              provider: "dropbox",
              remotePath: "moltbot-share",
              onSessionStart: true,
            },
          },
        },
      },
    };

    await workspaceSyncHandler(event as never);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("First sync requires manual --resync"),
    );
  });
});

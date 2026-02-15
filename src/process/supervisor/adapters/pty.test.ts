import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, ptyKillMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  ptyKillMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
}));

vi.mock("@lydell/node-pty", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

function createStubPty(pid = 1234) {
  return {
    pid,
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    kill: (signal?: string) => ptyKillMock(signal),
  };
}

describe("createPtyAdapter", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    ptyKillMock.mockReset();
    killProcessTreeMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("forwards explicit signals to node-pty kill", async () => {
    spawnMock.mockReturnValue(createStubPty());
    const { createPtyAdapter } = await import("./pty.js");

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "sleep 10"],
    });

    adapter.kill("SIGTERM");
    expect(ptyKillMock).toHaveBeenCalledWith("SIGTERM");
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  it("uses process-tree kill for SIGKILL by default", async () => {
    spawnMock.mockReturnValue(createStubPty());
    const { createPtyAdapter } = await import("./pty.js");

    const adapter = await createPtyAdapter({
      shell: "bash",
      args: ["-lc", "sleep 10"],
    });

    adapter.kill();
    expect(killProcessTreeMock).toHaveBeenCalledWith(1234);
    expect(ptyKillMock).not.toHaveBeenCalled();
  });

  it("does not pass a signal to node-pty on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      spawnMock.mockReturnValue(createStubPty());
      const { createPtyAdapter } = await import("./pty.js");

      const adapter = await createPtyAdapter({
        shell: "powershell.exe",
        args: ["-NoLogo"],
      });

      adapter.kill("SIGTERM");
      expect(ptyKillMock).toHaveBeenCalledWith(undefined);
      expect(killProcessTreeMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("uses process-tree kill for SIGKILL on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      spawnMock.mockReturnValue(createStubPty(4567));
      const { createPtyAdapter } = await import("./pty.js");

      const adapter = await createPtyAdapter({
        shell: "powershell.exe",
        args: ["-NoLogo"],
      });

      adapter.kill("SIGKILL");
      expect(killProcessTreeMock).toHaveBeenCalledWith(4567);
      expect(ptyKillMock).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});

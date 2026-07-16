import { afterEach, describe, expect, it, vi } from "vitest";

const { runExecMock, spawnCommandMock } = vi.hoisted(() => ({
  runExecMock: vi.fn(),
  spawnCommandMock: vi.fn(),
}));

vi.mock("../../process/exec.js", () => ({
  runExec: runExecMock,
  spawnCommand: spawnCommandMock,
}));

import {
  execConfigOpenCommand,
  formatConfigOpenError,
  isConfigOpenHandlerUnavailable,
  resolveConfigOpenCommand,
} from "./config-open.js";

function commandFailure(message: string, details: { code?: string; exitCode?: number } = {}) {
  return Object.assign(new Error(message), {
    failed: true,
    ...details,
  });
}

function fakeChild(result: Promise<unknown>) {
  const unref = vi.fn();
  const kill = vi.fn();
  return {
    child: Object.assign(result, { kill, unref }),
    kill,
    unref,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("resolveConfigOpenCommand", () => {
  it("waits for the macOS launcher to exit", () => {
    expect(resolveConfigOpenCommand("/home/user/.openclaw/openclaw.json", "darwin")).toEqual({
      command: "open",
      args: ["/home/user/.openclaw/openclaw.json"],
      completion: "exit",
    });
  });

  it("observes only xdg-open startup on Linux", () => {
    expect(resolveConfigOpenCommand("/home/user/.openclaw/openclaw.json", "linux")).toEqual({
      command: "xdg-open",
      args: ["/home/user/.openclaw/openclaw.json"],
      completion: "startup",
    });
  });

  it("uses a quoted PowerShell FilePath and waits for its launcher", () => {
    expect(resolveConfigOpenCommand(String.raw`C:\tmp\o'hai & calc.json`, "win32")).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Start-Process -FilePath 'C:\tmp\o''hai & calc.json'`,
      ],
      completion: "exit",
    });
  });
});

describe("execConfigOpenCommand", () => {
  it("keeps a hard timeout for launchers whose exit represents startup", async () => {
    runExecMock.mockResolvedValue({ stdout: "", stderr: "" });
    const command = resolveConfigOpenCommand("/home/user/.openclaw/openclaw.json", "darwin");

    await execConfigOpenCommand(command);

    expect(runExecMock).toHaveBeenCalledWith("open", ["/home/user/.openclaw/openclaw.json"], {
      logOutput: false,
      timeoutMs: 5_000,
    });
  });

  it("detaches xdg-open while observing an immediate successful exit", async () => {
    const spawned = fakeChild(Promise.resolve({ failed: false }));
    spawnCommandMock.mockReturnValue(spawned.child);

    await execConfigOpenCommand(
      resolveConfigOpenCommand("/home/user/.openclaw/openclaw.json", "linux"),
    );

    expect(spawnCommandMock).toHaveBeenCalledWith(
      ["xdg-open", "/home/user/.openclaw/openclaw.json"],
      {
        cleanup: false,
        detached: true,
        reject: false,
        stdio: "ignore",
      },
    );
    expect(spawned.unref).toHaveBeenCalledOnce();
  });

  it("treats a long-lived xdg-open handler as launched without terminating it", async () => {
    vi.useFakeTimers();
    let settleChild: (result: unknown) => void = () => {};
    const childResult = new Promise<unknown>((resolve) => {
      settleChild = resolve;
    });
    const spawned = fakeChild(childResult);
    spawnCommandMock.mockReturnValue(spawned.child);
    let settled = false;

    const execution = execConfigOpenCommand(
      resolveConfigOpenCommand("/home/user/.openclaw/openclaw.json", "linux"),
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await execution;

    expect(settled).toBe(true);
    expect(spawned.kill).not.toHaveBeenCalled();
    settleChild(commandFailure("foreground editor exited later", { exitCode: 1 }));
    await Promise.resolve();
  });

  it("preserves an immediate missing-command failure", async () => {
    const spawned = fakeChild(
      Promise.resolve(commandFailure("spawn xdg-open ENOENT", { code: "ENOENT" })),
    );
    spawnCommandMock.mockReturnValue(spawned.child);

    const execution = execConfigOpenCommand(
      resolveConfigOpenCommand("/home/user/.openclaw/openclaw.json", "linux"),
    );

    await expect(execution).rejects.toThrow("spawn xdg-open ENOENT");
  });

  it("classifies xdg-open exit code 3 as an unavailable handler", async () => {
    const spawned = fakeChild(
      Promise.resolve(commandFailure("Command failed with exit code 3: xdg-open", { exitCode: 3 })),
    );
    spawnCommandMock.mockReturnValue(spawned.child);

    try {
      await execConfigOpenCommand(
        resolveConfigOpenCommand("/home/user/.openclaw/openclaw.json", "linux"),
      );
      throw new Error("expected xdg-open to fail");
    } catch (error) {
      expect(formatConfigOpenError(error)).toContain("exit code 3");
      expect(isConfigOpenHandlerUnavailable(error)).toBe(true);
    }
  });
});

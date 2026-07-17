import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runExecMock, spawnCommandMock } = vi.hoisted(() => ({
  runExecMock: vi.fn(),
  spawnCommandMock: vi.fn(),
}));

vi.mock("../../process/exec.js", () => ({
  runExec: runExecMock,
  spawnCommand: spawnCommandMock,
}));

import { execSessionWorkspaceOpen } from "./session-files-reveal-open.js";

function fakeChild(result: Promise<unknown>) {
  const unref = vi.fn();
  const kill = vi.fn();
  const stderr = new PassThrough();
  return {
    child: Object.assign(result, { kill, stderr, unref }),
    kill,
    stderr,
    unref,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("execSessionWorkspaceOpen", () => {
  it.each(["darwin", "win32"] as const)("bounds the %s launcher wait", async (platform) => {
    runExecMock.mockResolvedValue({ stdout: "", stderr: "" });
    const command = {
      command: platform === "darwin" ? "open" : "powershell.exe",
      args: ["/tmp/workspace"],
    };

    await execSessionWorkspaceOpen(command, platform);

    expect(runExecMock).toHaveBeenCalledWith(command.command, command.args, {
      logOutput: false,
      timeoutMs: 5_000,
    });
  });

  it("detaches xdg-open and preserves an immediate successful exit", async () => {
    const spawned = fakeChild(Promise.resolve({ failed: false }));
    spawnCommandMock.mockReturnValue(spawned.child);

    await execSessionWorkspaceOpen({ command: "xdg-open", args: ["/tmp/workspace"] }, "linux");

    expect(spawnCommandMock).toHaveBeenCalledWith(["xdg-open", "/tmp/workspace"], {
      buffer: false,
      cleanup: false,
      detached: true,
      reject: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(spawned.unref).toHaveBeenCalledOnce();
  });

  it("returns after startup observation without killing a foreground Linux handler", async () => {
    vi.useFakeTimers();
    let settleChild: (value: unknown) => void = () => {};
    const childResult = new Promise<unknown>((resolve) => {
      settleChild = resolve;
    });
    const spawned = fakeChild(childResult);
    spawnCommandMock.mockReturnValue(spawned.child);
    let settled = false;

    const execution = execSessionWorkspaceOpen(
      { command: "xdg-open", args: ["/tmp/workspace"] },
      "linux",
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await execution;

    expect(settled).toBe(true);
    expect(spawned.kill).not.toHaveBeenCalled();
    expect(spawned.stderr.destroyed).toBe(false);
    expect(spawned.stderr.write("foreground handler: delayed diagnostic")).toBe(true);
    settleChild({ failed: false });
    await Promise.resolve();
    expect(spawned.stderr.destroyed).toBe(true);
  });

  it("propagates an immediate Linux launcher failure", async () => {
    let rejectChild: (error: Error) => void = () => {};
    const spawned = fakeChild(
      new Promise((_, reject) => {
        rejectChild = reject;
      }),
    );
    spawnCommandMock.mockReturnValue(spawned.child);

    const execution = execSessionWorkspaceOpen(
      { command: "xdg-open", args: ["/tmp/workspace"] },
      "linux",
    );
    spawned.stderr.write("xdg-open: no method available for opening '/tmp/workspace'");
    rejectChild(new Error("Command failed with exit code 3: xdg-open"));

    await expect(execution).rejects.toThrow("xdg-open: no method available");
  });
});

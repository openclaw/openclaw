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

import { createDeferred } from "../../../test/helpers/promise.js";
import { execOpenPath, isHeadlessOpenPathError, resolveOpenPathCommand } from "./open-path.js";

function fakeChild(result: Promise<unknown>) {
  const unref = vi.fn();
  const kill = vi.fn();
  const stderr = new PassThrough();
  return {
    child: Object.assign(result, { kill, stderr, nodeChildProcess: { unref } }),
    kill,
    stderr,
    unref,
  };
}

const linuxCommand = { command: "xdg-open", args: ["/tmp/workspace"] };
const headlessError = (error: Error, path = "/tmp/workspace") =>
  isHeadlessOpenPathError(error, resolveOpenPathCommand(path, "linux"), "linux");

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("resolveOpenPathCommand", () => {
  it("uses open on macOS", () => {
    expect(resolveOpenPathCommand("/tmp/openclaw.json", "darwin")).toEqual({
      command: "open",
      args: ["/tmp/openclaw.json"],
    });
  });

  it("uses a quoted PowerShell FilePath on Windows", () => {
    expect(resolveOpenPathCommand(String.raw`C:\tmp\o'hai & calc.json`, "win32")).toEqual({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`Start-Process -FilePath 'C:\tmp\o''hai & calc.json'`,
      ],
    });
  });
});

describe("execOpenPath", () => {
  it("bounds the non-Linux launcher wait", async () => {
    runExecMock.mockResolvedValue({ stdout: "", stderr: "" });
    const command = { command: "open", args: ["/tmp/workspace"] };

    await execOpenPath(command, "darwin");

    expect(runExecMock).toHaveBeenCalledWith(command.command, command.args, {
      logOutput: false,
      timeoutMs: 5_000,
    });
  });

  it("returns after startup observation without killing a foreground Linux handler", async () => {
    vi.useFakeTimers();
    const { promise: childResult, resolve: settleChild } = createDeferred<unknown>();
    const spawned = fakeChild(childResult);
    spawnCommandMock.mockReturnValue(spawned.child);
    let settled = false;

    const execution = execOpenPath(linuxCommand, "linux").then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await execution;

    expect(settled).toBe(true);
    expect(spawnCommandMock).toHaveBeenCalledWith(["xdg-open", "/tmp/workspace"], {
      buffer: false,
      cleanup: false,
      detached: true,
      reject: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(spawned.unref).toHaveBeenCalledOnce();
    expect(spawned.kill).not.toHaveBeenCalled();
    expect(spawned.stderr.destroyed).toBe(false);
    expect(spawned.stderr.write("foreground handler: delayed diagnostic")).toBe(true);
    settleChild({ failed: false });
    await Promise.resolve();
    expect(spawned.stderr.destroyed).toBe(true);
  });

  it("keeps xdg-open stderr truncation surrogate-safe", async () => {
    const { promise, reject } = createDeferred<unknown>();
    const spawned = fakeChild(promise);
    spawnCommandMock.mockReturnValue(spawned.child);

    const execution = execOpenPath(linuxCommand, "linux");
    // 4095 ASCII chars plus one emoji: a plain slice for the final slot would
    // keep only the emoji's high surrogate half.
    spawned.stderr.write(`${"x".repeat(4095)}🤖`);
    reject(new Error("Command failed with exit code 3: xdg-open"));
    const expectedMessage = `Command failed with exit code 3: xdg-open: ${"x".repeat(4_095)}`;
    await expect(execution).rejects.toHaveProperty("message", expectedMessage);
  });
});

describe("isHeadlessOpenPathError", () => {
  it.each([
    { platform: "linux", command: "xdg-open", code: "ENOENT", expected: true },
    { platform: "linux", command: "xdg-open", code: "EACCES", expected: false },
    { platform: "linux", command: "other-opener", code: "ENOENT", expected: false },
    { platform: "freebsd", command: "xdg-open", code: "ENOENT", expected: false },
  ] as const)("classifies $platform $command $code", ({ platform, command, code, expected }) => {
    const error = Object.assign(new Error("Launcher failed"), { code });
    expect(isHeadlessOpenPathError(error, { command, args: ["/tmp/workspace"] }, platform)).toBe(
      expected,
    );
  });

  it("preserves the installed xdg-open handlerless diagnostic", () => {
    expect(
      headlessError(new Error("xdg-open: no method available for opening '/tmp/workspace'")),
    ).toBe(true);
  });

  it("does not classify a handler diagnostic containing ENOENT as a missing launcher", () => {
    expect(
      headlessError(
        new Error("Command failed with exit code 1: xdg-open /tmp/ENOENT-workspace"),
        "/tmp/ENOENT-workspace",
      ),
    ).toBe(false);
  });
});

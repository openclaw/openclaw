import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

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
  const child = Object.assign(result, {
    kill: vi.fn(),
    stderr: new PassThrough(),
    nodeChildProcess: { unref: vi.fn() },
  });
  spawnCommandMock.mockReturnValue(child);
  return child;
}

const linuxCommand = { command: "xdg-open", args: ["/tmp/workspace"] };
const headlessError = (error: Error, path = "/tmp/workspace") =>
  isHeadlessOpenPathError(error, resolveOpenPathCommand(path, "linux"), "linux");

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each([
  ["darwin", "/tmp/openclaw.json", "open", ["/tmp/openclaw.json"]],
  [
    "win32",
    String.raw`C:\tmp\o'hai & calc.json`,
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      String.raw`Start-Process -FilePath 'C:\tmp\o''hai & calc.json'`,
    ],
  ],
] as const)("resolves %s launcher with a safely quoted path", (platform, path, command, args) => {
  expect(resolveOpenPathCommand(path, platform)).toEqual({ command, args });
});
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
  const { promise, resolve } = createDeferred<unknown>();
  const spawned = fakeChild(promise);
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
  expect(spawned.nodeChildProcess.unref).toHaveBeenCalledOnce();
  expect(spawned.kill).not.toHaveBeenCalled();
  expect(spawned.stderr.destroyed).toBe(false);
  expect(spawned.stderr.write("foreground handler: delayed diagnostic")).toBe(true);
  resolve({ failed: false });
  await Promise.resolve();
  expect(spawned.stderr.destroyed).toBe(true);
});

it("keeps xdg-open stderr truncation surrogate-safe", async () => {
  const { promise, reject } = createDeferred<unknown>();
  const spawned = fakeChild(promise);

  const execution = execOpenPath(linuxCommand, "linux");
  // 4095 ASCII chars plus one emoji: a plain slice for the final slot would
  // keep only the emoji's high surrogate half.
  spawned.stderr.write(`${"x".repeat(4095)}🤖`);
  reject(new Error("Command failed with exit code 3: xdg-open"));
  const expectedMessage = `Command failed with exit code 3: xdg-open: ${"x".repeat(4_095)}`;
  await expect(execution).rejects.toHaveProperty("message", expectedMessage);
});
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

it.each([
  ["xdg-open: no method available for opening '/tmp/workspace'", "/tmp/workspace", true],
  [
    "Command failed with exit code 1: xdg-open /tmp/ENOENT-workspace",
    "/tmp/ENOENT-workspace",
    false,
  ],
] as const)("classifies handler diagnostic %s", (message, path, expected) => {
  expect(headlessError(new Error(message), path)).toBe(expected);
});

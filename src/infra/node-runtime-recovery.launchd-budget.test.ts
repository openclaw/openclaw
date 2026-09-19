// Deadline policy complements the native launchd fixture: the wrapper must
// reap its child before launchd can kill the wrapper at its 20-second limit.
import { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { runRespawnedChild } from "../../node-runtime-recovery.mjs";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

const originalArgv = process.argv;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const exitSentinel = new Error("fixture exit");
let child: ChildProcess | undefined;

afterEach(() => {
  if (child?.listenerCount("exit")) {
    expect(() => child?.emit("exit", 0, null)).toThrow(exitSentinel);
  }
  child = undefined;
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  {
    platform: "darwin",
    label: "ai.openclaw.fixture",
    xpc: "ai.openclaw.fixture",
    command: "run",
    grace: 18_000,
  },
  {
    platform: "darwin",
    label: " ai.openclaw.fixture ",
    xpc: "ai.openclaw.fixture",
    command: "run",
    grace: 18_000,
  },
  {
    platform: "darwin",
    label: "ai.openclaw.fixture",
    xpc: "ai.openclaw.other",
    command: "run",
    grace: 328_000,
  },
  { platform: "darwin", label: "", xpc: "", command: "run", grace: 328_000 },
  {
    platform: "linux",
    label: "ai.openclaw.fixture",
    xpc: "ai.openclaw.fixture",
    command: "run",
    grace: 328_000,
  },
  {
    platform: "win32",
    label: "ai.openclaw.fixture",
    xpc: "ai.openclaw.fixture",
    command: "run",
    grace: 328_000,
  },
  {
    platform: "darwin",
    label: "ai.openclaw.fixture",
    xpc: "ai.openclaw.fixture",
    command: "status",
    grace: 1_000,
  },
])(
  "bounds $platform $command for label=$label and xpc=$xpc",
  ({ platform, label, xpc, command, grace }) => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    process.argv = [process.execPath, "/fixture/openclaw.mjs", "gateway", command];
    child = new ChildProcess();
    mocks.spawn.mockReturnValue(child);
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw exitSentinel;
    });
    const before = new Set(process.listeners("SIGTERM"));
    runRespawnedChild(process.execPath, process.argv.slice(1), {
      OPENCLAW_LAUNCHD_LABEL: label,
      XPC_SERVICE_NAME: xpc,
    });
    const signal = process.listeners("SIGTERM").find((listener) => !before.has(listener));
    expect(signal).toBeTypeOf("function");
    signal!("SIGTERM");
    kill.mockClear();
    vi.advanceTimersByTime(grace - 1);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.advanceTimersByTime(1_000);
    expect(kill).toHaveBeenLastCalledWith(platform === "win32" ? "SIGTERM" : "SIGKILL");
  },
);

import { ChildProcess, type SpawnOptions } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runRespawnedChild } from "../../node-runtime-recovery.mjs";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<(file: string, args: string[], options: SpawnOptions) => ChildProcess>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
const originalArgv = process.argv;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const hostPlatform = process.platform;
const exitSentinel = new Error("replacement exited");
let child: ChildProcess;
let exitSpy: MockInstance<typeof process.exit>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
function mockProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}
beforeEach(() => {
  mockProcessPlatform("linux");
  vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", undefined);
  child = new ChildProcess();
  mocks.spawn.mockReset().mockReturnValue(child);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
    throw exitSentinel;
  });
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  if (child.listenerCount("exit")) {
    expect(() => child.emit("exit", 0, null)).toThrow(exitSentinel);
  }
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runtime recovery child shutdown", () => {
  function start(argvTail: string[]) {
    vi.useFakeTimers();
    process.argv = [process.execPath, "/fixture/openclaw.mjs", ...argvTail];
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const before = new Set(process.listeners("SIGTERM"));
    runRespawnedChild(process.execPath, process.argv.slice(1), process.env);
    const signal = expectDefined(
      process.listeners("SIGTERM").find((fn) => !before.has(fn)),
      "signal listener",
    );
    return { kill, signal };
  }

  afterEach(() => {
    // Detach before restoring clocks, including on assertion failure.
    if (child.listenerCount("exit")) {
      expect(() => child.emit("exit", 0, null)).toThrow(exitSentinel);
    }
    vi.useRealTimers();
  });

  it.each([
    ["gateway"],
    ["gateway", "run"],
    ["--profile", "fixture", "gateway", "run"],
    ["--dev", "--no-color", "--log-level=debug", "gateway", "run"],
    ["gateway", "--container", "fixture", "run", "--port=18789", "--bind", "loopback"],
    ["gateway", "--token", "run"],
    ["gateway", "--token", "--help"],
    ["gateway", "run", "--token=--", "--compact", "--ambient-channels"],
    ["--", "gateway", "run"],
    ["gateway", "--", "run"],
  ])("retains foreground drain for %j", (...args) => {
    const { kill, signal } = start(args);
    signal("SIGTERM");
    vi.advanceTimersByTime(327_999);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["agent", "run"],
    ["gateway", "status"],
    ["gateway", "stop"],
    ["gateway", "restart"],
    ["gateway", "run", "status"],
    ["gateway", "run", "run"],
    ["gateway", "--help"],
    ["gateway", "run", "-h"],
    ["gateway", "--version"],
    ["--profile", "gateway", "run"],
    ["--container=gateway", "run"],
    ["gateway", "--port"],
    ["gateway", "--profile"],
    ["gateway", "--unknown"],
    ["gateway", "--compact=true"],
    ["--dev=true", "gateway"],
    ["gateway", "--", "--port", "18789"],
    ["--", "--profile", "fixture", "gateway"],
    ["--port", "18789", "gateway"],
    ["gateway", ""],
  ])("keeps administrative or malformed invocation short: %j", (...args) => {
    const { kill, signal } = start(args);
    signal("SIGTERM");
    vi.advanceTimersByTime(1_000);
    expect(kill).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    expect(kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it.each(
    (["linux", "win32"] as const).flatMap((platform) =>
      [
        ["gateway", "--token", ""],
        ["gateway", "--token", "   "],
        ["gateway", "run", "--token="],
        ["gateway", "run", "--raw-stream-path", ""],
        ["gateway", "--raw-stream-path=", "run"],
        ["gateway", "--port="],
        ["gateway", "--profile="],
        ["--profile", "", "gateway", "run"],
      ].map((args) => ({ platform, args })),
    ),
  )(
    "retains foreground policy for explicit empty values on $platform: $args",
    ({ platform, args }) => {
      mockProcessPlatform(platform);
      Object.defineProperty(child, "connected", { value: true });
      const send = vi.fn().mockReturnValue(true);
      child.send = send;
      const { kill, signal } = start(args);
      signal("SIGTERM");
      vi.advanceTimersByTime(327_999);
      if (platform === "win32") {
        expect(send).toHaveBeenCalledExactlyOnceWith(
          { type: "openclaw.launcher.gateway-stop", signal: "SIGTERM" },
          expect.any(Function),
        );
        expect(kill).not.toHaveBeenCalled();
      } else {
        expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      }
      vi.advanceTimersByTime(1);
      expect(kill).toHaveBeenLastCalledWith("SIGTERM");
    },
  );

  // The module registers the host's supported signals at import time. The IPC
  // process suite separately covers SIGBREAK mapping on every host.
  it.each(
    (["SIGTERM", "SIGINT", "SIGBREAK"] as const).filter(
      (signal) => signal !== "SIGBREAK" || hostPlatform === "win32",
    ),
  )("transports Windows Gateway %s cooperatively before its fixed deadline", (stopSignal) => {
    mockProcessPlatform("win32");
    Object.defineProperty(child, "connected", { value: true });
    const send = vi.fn().mockReturnValue(true);
    child.send = send;
    const before = new Set(process.listeners(stopSignal));
    const { kill } = start(["gateway", "run"]);
    const signal = expectDefined(
      process.listeners(stopSignal).find((fn) => !before.has(fn)),
      "Windows signal listener",
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      process.argv.slice(1),
      expect.objectContaining({ stdio: ["inherit", "inherit", "inherit", "ipc"] }),
    );
    signal(stopSignal);
    vi.advanceTimersByTime(200_000);
    signal(stopSignal);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { type: "openclaw.launcher.gateway-stop", signal: stopSignal },
      expect.any(Function),
    );
    vi.advanceTimersByTime(127_999);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.advanceTimersByTime(1_000);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(() => vi.advanceTimersByTime(1_000)).toThrow(exitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each(["disconnected", "throws", "callback-error"])(
    "keeps the Windows Gateway deadline when IPC %s",
    (failure) => {
      mockProcessPlatform("win32");
      Object.defineProperty(child, "connected", { value: failure !== "disconnected" });
      child.send = vi.fn().mockImplementation((_message, callback) => {
        if (failure === "throws") {
          throw new Error("IPC unavailable");
        }
        callback(new Error("IPC closed"));
        return false;
      });
      const { kill, signal } = start(["gateway", "run"]);
      signal("SIGTERM");
      vi.advanceTimersByTime(327_999);
      expect(kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    },
  );

  it("keeps ordinary Windows commands on their short signal path", () => {
    mockProcessPlatform("win32");
    const { kill, signal } = start(["gateway", "status"]);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      process.argv.slice(1),
      expect.objectContaining({ stdio: "inherit" }),
    );
    signal("SIGTERM");
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.advanceTimersByTime(1_000);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("does not extend the deadline on repeated signals or later argv changes", () => {
    const { kill, signal } = start(["gateway", "run"]);
    process.argv = [process.execPath, "/fixture/openclaw.mjs", "status"];
    signal("SIGTERM");
    vi.advanceTimersByTime(200_000);
    signal("SIGTERM");
    expect(kill).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(128_000);
    expect(kill).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_000);
    expect(kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(() => vi.advanceTimersByTime(1_000)).toThrow(exitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each(["exit", "error"])("clears every signal timer and listener on early %s", (event) => {
    const before = process.listeners("SIGTERM");
    const { signal } = start(["gateway", "run"]);
    signal("SIGTERM");
    if (event === "exit") {
      expect(() => child.emit("exit", 17, null)).toThrow(exitSentinel);
      expect(exitSpy).toHaveBeenCalledWith(17);
    } else {
      expect(() => child.emit("error", new Error("spawn failed"))).toThrow(exitSentinel);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("spawn failed"));
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listeners("SIGTERM")).toEqual(before);
  });
});

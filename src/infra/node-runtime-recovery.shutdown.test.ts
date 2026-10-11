import { ChildProcess, type SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { runRespawnedChild } from "../../node-runtime-recovery.mjs";

const spawn = vi.hoisted(() =>
  vi.fn<(command: string, args: string[], options: SpawnOptions) => ChildProcess>(),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

let child: ChildProcess;
let kill: MockInstance<ChildProcess["kill"]>;
let processKill: MockInstance<typeof process.kill>;
let completion: ReturnType<typeof runRespawnedChild> | undefined;
let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  vi.useFakeTimers();
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  child = new ChildProcess();
  kill = vi.spyOn(child, "kill").mockReturnValue(true);
  spawn.mockReset();
  spawn.mockReturnValue(child);
  processKill = vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(async () => {
  child.emit("close", 0, null);
  await completion;
  completion = undefined;
  process.exitCode = originalExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  { platform: "linux", args: ["gateway", "run"], nativeBudgetMs: 330_000 },
  { platform: "darwin", args: ["gateway"], nativeBudgetMs: 330_000 },
  { platform: "linux", args: ["gateway", "status"], nativeBudgetMs: 3_000 },
  { platform: "win32", args: ["gateway", "run"], nativeBudgetMs: 3_000 },
] as const)(
  "bounds $platform $args shutdown without preempting the serving owner",
  async ({ platform, args, nativeBudgetMs }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "openclaw.mjs",
      "--profile=fixture",
      ...args,
    ]);
    const previous = new Set(process.listeners("SIGTERM"));
    completion = runRespawnedChild("node", ["child.mjs"], {
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.fixture",
      XPC_SERVICE_NAME: "ai.openclaw.fixture",
    });
    let completed = false;
    void completion.then(() => {
      completed = true;
    });
    // No new environment contract is needed to give newly started launchers the
    // full service budget; legacy parent compatibility stays with the Gateway.
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "node",
      ["child.mjs"],
      expect.objectContaining({
        env: {
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.fixture",
          XPC_SERVICE_NAME: "ai.openclaw.fixture",
        },
      }),
    );
    const signal = process.listeners("SIGTERM").find((listener) => !previous.has(listener));
    expect(signal).toBeDefined();
    signal!("SIGTERM");
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.advanceTimersByTime(nativeBudgetMs - 2_001);
    expect(kill).toHaveBeenCalledTimes(1);
    signal!("SIGTERM");
    expect(kill).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_000);
    const childSignal = platform === "win32" ? "SIGTERM" : "SIGKILL";
    expect(kill).toHaveBeenLastCalledWith(childSignal);
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(process.exitCode).toBeUndefined();
    child.emit("exit", null, childSignal);
    expect(process.exitCode).toBeUndefined();
    child.emit("close", null, childSignal);
    await expect(completion).resolves.toBe(true);
    expect(process.exitCode).toBe(platform === "win32" ? 1 : 137);
    if (platform === "win32") {
      expect(processKill).not.toHaveBeenCalled();
    } else {
      expect(processKill).toHaveBeenCalledExactlyOnceWith(process.pid, childSignal);
    }
    expect(process.listeners("SIGTERM")).toEqual([...previous]);
  },
);

it.each([
  { platform: "linux", childSignal: "SIGTERM", expected: 143 },
  { platform: "linux", childSignal: "SIGINT", expected: 130 },
  { platform: "linux", childSignal: "SIGHUP", expected: 129 },
  { platform: "linux", childSignal: "SIGQUIT", expected: 131 },
  { platform: "linux", childSignal: "SIGKILL", expected: 137 },
  { platform: "win32", childSignal: "SIGTERM", expected: 143 },
] as const)(
  "records actual $platform $childSignal only after pipes close",
  async ({ platform, childSignal, expected }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "openclaw.mjs", "gateway"]);
    const previous = process.listeners("SIGTERM");
    completion = runRespawnedChild("node", ["child.mjs"], {});
    const forward = process.listeners("SIGTERM").find((listener) => !previous.includes(listener))!;
    forward("SIGTERM");
    child.emit("exit", null, childSignal);
    forward("SIGTERM");
    vi.advanceTimersByTime(330_000);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(process.exitCode).toBeUndefined();
    expect(process.listeners("SIGTERM")).toContain(forward);
    child.emit("close", null, childSignal);
    await expect(completion).resolves.toBe(true);
    expect(process.exitCode).toBe(expected);
    if (platform === "win32") {
      expect(processKill).not.toHaveBeenCalled();
    } else {
      expect(processKill).toHaveBeenCalledExactlyOnceWith(process.pid, childSignal);
    }
    expect(process.listeners("SIGTERM")).toEqual(previous);
  },
);

it("records spawn failure only after its close notification", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  completion = runRespawnedChild("missing-node", [], {});
  child.emit("error", new Error("spawn ENOENT"));
  expect(process.exitCode).toBeUndefined();
  child.emit("close", -2, null);
  await expect(completion).resolves.toBe(true);
  expect(process.exitCode).toBe(1);
});

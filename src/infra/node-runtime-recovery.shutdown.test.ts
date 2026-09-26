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
let exit: MockInstance<typeof process.exit>;
let detach: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  child = new ChildProcess();
  kill = vi.spyOn(child, "kill").mockReturnValue(true);
  // `spawn` is hoisted once for the file, so its call log survives across cases
  // and `toHaveBeenCalledExactlyOnceWith` would only ever hold for the first one.
  spawn.mockClear();
  spawn.mockReturnValue(child);
  exit = vi.spyOn(process, "exit").mockImplementation(vi.fn<typeof process.exit>());
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  detach?.();
  detach = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  { platform: "linux", args: ["gateway", "run"], nativeBudgetMs: 330_000 },
  { platform: "darwin", args: ["gateway"], nativeBudgetMs: 20_000 },
  { platform: "linux", args: ["gateway", "status"], nativeBudgetMs: 3_000 },
  { platform: "win32", args: ["gateway", "run"], nativeBudgetMs: 3_000 },
] as const)(
  "bounds $platform $args shutdown without preempting the serving owner",
  ({ platform, args, nativeBudgetMs }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "openclaw.mjs",
      "--profile=fixture",
      ...args,
    ]);
    const previous = new Set(process.listeners("SIGTERM"));
    runRespawnedChild("node", ["child.mjs"], {
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.fixture",
      XPC_SERVICE_NAME: "ai.openclaw.fixture",
    });
    detach = () => child.emit("exit", 0, null);
    // The launcher tells the child nothing about the timer it armed: the serving
    // Gateway derives the same deadline from the same shared expression, which is what
    // lets a Gateway started by an already-running older launcher bound itself
    // correctly. So the env must reach the child unchanged, and the escalation
    // asserted below is what that derivation has to land on.
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
    // Reserve the final two seconds for escalation; all earlier time belongs to the child.
    vi.advanceTimersByTime(nativeBudgetMs - 2_001);
    expect(kill).toHaveBeenCalledTimes(1);
    signal!("SIGTERM");
    expect(kill).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_000);
    expect(kill).toHaveBeenLastCalledWith(platform === "win32" ? "SIGTERM" : "SIGKILL");
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  },
);

it("removes the shutdown deadline when the child exits cooperatively", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "openclaw.mjs", "gateway"]);
  const previous = new Set(process.listeners("SIGTERM"));
  runRespawnedChild("node", ["child.mjs"], {});
  detach = () => child.emit("exit", 0, null);
  process.listeners("SIGTERM").find((listener) => !previous.has(listener))!("SIGTERM");
  vi.advanceTimersByTime(3_000);
  child.emit("exit", 0, null);
  vi.advanceTimersByTime(330_000);
  expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(process.listeners("SIGTERM")).toEqual([...previous]);
});

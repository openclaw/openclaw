import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { resolveOpenClawCliRespawn } from "../../cli-invocation.mjs";
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
import { runRespawnedChild } from "../../node-runtime-recovery.mjs";

const spawn = vi.hoisted(() => vi.fn<typeof import("node:child_process").spawn>());
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
  vi.unstubAllGlobals();
});

function respawn(options: Parameters<typeof resolveOpenClawCliRespawn>[0]) {
  return (completion = runRespawnedChild(resolveOpenClawCliRespawn(options)));
}

function start(platform: NodeJS.Platform, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "openclaw.mjs", ...args]);
  const previous = process.listeners("SIGTERM");
  const done = respawn({ execPath: "node", entryPath: "child.mjs", execArgv: [], args: [], env });
  return {
    done,
    previous,
    forward: process.listeners("SIGTERM").find((listener) => !previous.includes(listener))!,
  };
}

function expectExitSignal(platform: NodeJS.Platform, signal: NodeJS.Signals) {
  expect(processKill.mock.calls).toEqual(platform === "win32" ? [] : [[process.pid, signal]]);
}

async function closeChild(code: number | null, signal: NodeJS.Signals | null, exitCode: number) {
  child.emit("close", code, signal);
  await expect(completion).resolves.toBe(true);
  expect(process.exitCode).toBe(exitCode);
}

it.each([
  { platform: "linux", args: ["gateway", "run"], nativeBudgetMs: 330_000 },
  { platform: "darwin", args: ["gateway"], nativeBudgetMs: 330_000 },
  { platform: "linux", args: ["gateway", "status"], nativeBudgetMs: 3_000 },
  { platform: "win32", args: ["gateway", "run"], nativeBudgetMs: 3_000 },
] as const)(
  "bounds $platform $args shutdown without preempting the serving owner",
  async ({ platform, args, nativeBudgetMs }) => {
    const env = {
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.fixture",
      XPC_SERVICE_NAME: "ai.openclaw.fixture",
    };
    const { done, previous, forward } = start(platform, ["--profile=fixture", ...args], env);
    let completed = false;
    void done.then(() => {
      completed = true;
    });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "node",
      ["--import", CLI_PARENT_BOUND_PRELOAD, "child.mjs"],
      expect.objectContaining({ env }),
    );
    expect(forward).toBeDefined();
    forward("SIGTERM");
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.advanceTimersByTime(nativeBudgetMs - 2_001);
    expect(kill).toHaveBeenCalledTimes(1);
    forward("SIGTERM");
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
    await closeChild(null, childSignal, platform === "win32" ? 1 : 137);
    expectExitSignal(platform, childSignal);
    expect(process.listeners("SIGTERM")).toEqual(previous);
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
    const { previous, forward } = start(platform, ["gateway"]);
    forward("SIGTERM");
    child.emit("exit", null, childSignal);
    forward("SIGTERM");
    vi.advanceTimersByTime(330_000);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(process.exitCode).toBeUndefined();
    expect(process.listeners("SIGTERM")).toContain(forward);
    await closeChild(null, childSignal, expected);
    expectExitSignal(platform, childSignal);
    expect(process.listeners("SIGTERM")).toEqual(previous);
  },
);

it("records spawn failure only after its close notification", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  completion = runRespawnedChild({ command: "missing-node", args: [], env: {} });
  child.emit("error", new Error("spawn ENOENT"));
  expect(process.exitCode).toBeUndefined();
  await closeChild(-2, null, 1);
});

it("passes standalone CLI args and parent binding unchanged to the launcher child", async () => {
  vi.stubGlobal("__openclawStandaloneRootUrl", "file:///app/runtime/");
  respawn({ entryPath: "/app/runtime/openclaw.mjs", args: ["doctor", "--fix"], env: {} });
  expect(spawn).toHaveBeenCalledExactlyOnceWith(
    process.execPath,
    ["doctor", "--fix"],
    expect.objectContaining({
      env: { OPENCLAW_CLI_RESPAWN_PARENT: String(process.pid) },
    }),
  );
  await closeChild(0, null, 0);
});

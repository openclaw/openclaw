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

async function closeChild(code: number | null, signal: NodeJS.Signals | null, exitCode: number) {
  child.emit("close", code, signal);
  expect([await completion, process.exitCode]).toEqual([true, exitCode]);
  expect(processKill.mock.calls).toEqual(
    signal && process.platform !== "win32" ? [[process.pid, signal]] : [],
  );
}

it.each([
  ["linux", ["gateway", "run"], 330_000],
  ["darwin", ["gateway"], 330_000],
  ["linux", ["gateway", "status"], 3_000],
  ["win32", ["gateway", "run"], 3_000],
] as const)("bounds %s %j shutdown", async (platform, args, budget) => {
  const env = { OPENCLAW_LAUNCHD_LABEL: "fixture", XPC_SERVICE_NAME: "fixture" };
  const { done, previous, forward } = start(platform, ["--profile=fixture", ...args], env);
  const completed = vi.fn();
  void done.then(completed);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(
    "node",
    ["--import", CLI_PARENT_BOUND_PRELOAD, "child.mjs"],
    expect.objectContaining({ env }),
  );
  expect(forward).toBeDefined();
  forward("SIGTERM");
  expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  vi.advanceTimersByTime(budget - 2_001);
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
  expect(completed).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
  child.emit("exit", null, childSignal);
  expect(process.exitCode).toBeUndefined();
  await closeChild(null, childSignal, platform === "win32" ? 1 : 137);
  expect(process.listeners("SIGTERM")).toEqual(previous);
});

it.each([
  ["linux", "SIGTERM", 143],
  ["linux", "SIGINT", 130],
  ["linux", "SIGHUP", 129],
  ["linux", "SIGQUIT", 131],
  ["linux", "SIGKILL", 137],
  ["win32", "SIGTERM", 143],
] as const)("defers %s %s exit status", async (platform, childSignal, expected) => {
  const { previous, forward } = start(platform, ["gateway"]);
  forward("SIGTERM");
  child.emit("exit", null, childSignal);
  forward("SIGTERM");
  vi.advanceTimersByTime(330_000);
  expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(process.exitCode).toBeUndefined();
  expect(process.listeners("SIGTERM")).toContain(forward);
  await closeChild(null, childSignal, expected);
  expect(process.listeners("SIGTERM")).toEqual(previous);
});

it("records spawn failure only after its close notification", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  completion = runRespawnedChild({ command: "missing-node", args: [], env: {} });
  child.emit("error", new Error("spawn ENOENT"));
  expect(process.exitCode).toBeUndefined();
  await closeChild(-2, null, 1);
});

it("passes standalone CLI args and parent binding unchanged to the launcher child", async () => {
  vi.stubGlobal("__openclawStandaloneRootUrl", "file:///app/runtime/");
  completion = runRespawnedChild(
    resolveOpenClawCliRespawn({
      entryPath: "/app/runtime/openclaw.mjs",
      args: ["doctor", "--fix"],
      env: {},
    }),
  );
  expect(spawn).toHaveBeenCalledExactlyOnceWith(
    process.execPath,
    ["doctor", "--fix"],
    expect.objectContaining({
      env: { OPENCLAW_CLI_RESPAWN_PARENT: String(process.pid) },
    }),
  );
  await closeChild(0, null, 0);
});

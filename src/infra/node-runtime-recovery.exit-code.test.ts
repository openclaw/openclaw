import { ChildProcess, type SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";

const spawn = vi.hoisted(() =>
  vi.fn<(command: string, args: string[], options: SpawnOptions) => ChildProcess>(),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

let child: ChildProcess;
let exit: MockInstance<typeof process.exit>;
const respawnSignals = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;
let baselineListeners: Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>;
beforeEach(() => {
  baselineListeners = new Map(
    respawnSignals.map((signal) => [signal, new Set(process.listeners(signal))]),
  );
  vi.useFakeTimers();
  child = new ChildProcess();
  vi.spyOn(child, "kill").mockReturnValue(true);
  spawn.mockReturnValue(child);
  exit = vi.spyOn(process, "exit").mockImplementation(vi.fn<typeof process.exit>());
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  // The supervisor registers every respawn signal and only detaches when the child exits,
  // so drop everything it added even if a test failed before emitting the exit.
  for (const [signal, baseline] of baselineListeners) {
    for (const listener of process.listeners(signal)) {
      if (!baseline.has(listener)) {
        process.off(signal, listener);
      }
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each([
  { signal: "SIGINT", reported: "SIGINT", code: 130 },
  { signal: "SIGTERM", reported: "SIGTERM", code: 143 },
  // libuv has no SIGBREAK kill; Windows reports the terminated child as SIGKILL.
  { signal: "SIGBREAK", reported: "SIGKILL", code: 149 },
] as const)(
  "maps a forwarded win32 $signal to exit code $code exactly once",
  async ({ signal, reported, code }) => {
    // respawnSignals is computed at module load from process.platform, so the mock
    // must be in place, and the module reimported, before evaluating its top level.
    vi.resetModules();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "openclaw.mjs", "gateway", "run"]);
    const { runRespawnedChild } = await import("../../node-runtime-recovery.mjs");
    runRespawnedChild("node", ["child.mjs"], {});
    const listener = process
      .listeners(signal)
      .find((candidate) => !baselineListeners.get(signal)!.has(candidate));
    expect(listener).toBeDefined();
    listener!(signal);
    child.emit("exit", null, reported);
    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
  },
);

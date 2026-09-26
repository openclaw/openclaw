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
let addedSignal: NodeJS.Signals | undefined;
let addedListener: NodeJS.SignalsListener | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  child = new ChildProcess();
  vi.spyOn(child, "kill").mockReturnValue(true);
  spawn.mockReturnValue(child);
  exit = vi.spyOn(process, "exit").mockImplementation(vi.fn<typeof process.exit>());
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  // Clean up even on assertion failure so a leaked listener can't affect later tests.
  if (addedSignal && addedListener) {
    process.off(addedSignal, addedListener);
  }
  addedSignal = undefined;
  addedListener = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each([
  { signal: "SIGINT", code: 130 },
  { signal: "SIGTERM", code: 143 },
  { signal: "SIGBREAK", code: 149 },
] as const)(
  "maps a forwarded win32 $signal to exit code $code exactly once",
  async ({ signal, code }) => {
    // respawnSignals is computed at module load from process.platform, so the mock
    // must be in place, and the module reimported, before evaluating its top level.
    vi.resetModules();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "openclaw.mjs", "gateway", "run"]);
    const { runRespawnedChild } = await import("../../node-runtime-recovery.mjs");
    const previous = new Set(process.listeners(signal));
    runRespawnedChild("node", ["child.mjs"], {});
    const listener = process.listeners(signal).find((candidate) => !previous.has(candidate));
    expect(listener).toBeDefined();
    addedSignal = signal;
    addedListener = listener;
    listener!(signal);
    child.emit("exit", null, signal);
    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
  },
);

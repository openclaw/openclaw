import { ChildProcess } from "node:child_process";
import type { ChildExit } from "@openclaw/proc-safe/reaper";
import { afterEach, expect, it, vi } from "vitest";
import { signalChildProcessTree } from "./child-process-tree.js";

const nativeReap = vi.hoisted(() =>
  vi.fn<(pid: number) => ChildExit | null>((pid) => ({
    pid,
    exitCode: 0,
    signal: null,
    signalNumber: null,
  })),
);
vi.mock("./kill-tree.js", () => ({ signalProcessTree: vi.fn() }));
vi.mock("@openclaw/proc-safe/reaper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/reaper")>()),
  isSupported: () => true,
  inspectChildWaitState: (pid: number) => ({ kind: "exited", pid }),
  reapChild: nativeReap,
}));
vi.mock("node:fs/promises", () => ({
  readdir: () => ["1"],
  readFile: (path: string) => {
    if (path.endsWith("/children")) {
      return "400 401 402";
    }
    const pid = Number(path.split("/")[2]);
    const group = pid === 402 ? 900 : 400;
    return `${pid} (fixture) Z ${process.pid} ${group} 0 0 0`;
  },
}));

const originalPlatform = process.platform;
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(31_000);
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

it("tree termination reaps adopted zombies after root exit without consuming other children", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockReturnValue(true);
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 400 });
  signalChildProcessTree(child, "SIGTERM");
  await vi.advanceTimersByTimeAsync(100);
  expect(nativeReap).not.toHaveBeenCalled();

  child.emit("exit", null, "SIGTERM");
  await vi.advanceTimersByTimeAsync(25);
  expect(nativeReap.mock.calls).toEqual([[401]]);
});

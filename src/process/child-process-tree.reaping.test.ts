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
vi.mock("node:fs", () => ({
  readdirSync: () => ["400", "401", "402"],
  readFileSync: (path: string) => {
    const pid = Number(path.split("/")[2]);
    const group = pid === 402 ? 900 : 400;
    return `${pid} (fixture) Z ${process.pid} ${group} 0 0 0`;
  },
}));

const originalPlatform = process.platform;
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

it("tree termination reaps adopted zombies after root exit without consuming other children", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 400 });
  signalChildProcessTree(child, "SIGTERM");
  vi.advanceTimersByTime(100);
  expect(nativeReap).not.toHaveBeenCalled();

  child.emit("exit", null, "SIGTERM");
  vi.advanceTimersByTime(25);
  expect(nativeReap.mock.calls).toEqual([[401]]);
});

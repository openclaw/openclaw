import { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { signalChildProcessTree } from "./child-process-tree.js";

const nativeWait = vi.hoisted(() => vi.fn<(pid: number) => number>((pid) => pid));
vi.mock("./kill-tree.js", () => ({ signalProcessTree: vi.fn() }));
vi.mock("node:module", () => ({
  createRequire: () => () => ({ load: () => ({ func: () => nativeWait }) }),
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
  expect(nativeWait).not.toHaveBeenCalled();

  child.emit("exit", null, "SIGTERM");
  vi.advanceTimersByTime(25);
  expect(nativeWait.mock.calls).toEqual([[401, null, 1]]);
});

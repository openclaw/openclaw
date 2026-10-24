import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observePostCoreCommand } from "../../scripts/e2e/lib/plugin-update/process-observer.mjs";

const argv = "node\0entry.js\0update\0--json\0";
const workerArgv =
  "node\0/opt/openclaw/dist/infra/update-migrated-finalize.worker.js\0--post-core\0";
const marker = "OPENCLAW_UPDATE_POST_CORE=1\0";
const procError = (code: string) => Object.assign(new Error(`proc read: ${code}`), { code });

describe("plugin update command observation", () => {
  let files: Map<string, string | Error>;
  let child: EventEmitter & { pid: number };
  const setProc = (pid: number, values: Record<string, string | Error>) => {
    for (const [file, value] of Object.entries(values)) {
      files.set(`/proc/${pid}/${file}`, value);
    }
  };
  const finish = (code = 0) => child.emit("exit", code, null);
  const observed = (pid: string, cmdline = argv, postCore: boolean | null = true) => ({
    pid,
    argv: cmdline.split("\0").filter(Boolean),
    postCore,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), { pid: 10 });
    files = new Map();
    setProc(10, { "task/10/children": "11 12" });
    for (const pid of [11, 12]) {
      setProc(pid, { cmdline: argv, environ: marker, [`task/${pid}/children`]: "" });
    }
    const readFile = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (!String(file).startsWith("/proc/")) {
        return readFile(file, options);
      }
      const value = files.get(String(file)) ?? procError("ENOENT");
      if (value instanceof Error) {
        throw value;
      }
      return value;
    });
  });

  afterEach(() => {
    const timers = vi.getTimerCount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(timers).toBe(0);
  });

  it("ESRCH leaves evidence unknown and keeps scanning readable siblings and grandchildren", async () => {
    setProc(11, { environ: procError("ESRCH"), "task/11/children": "13" });
    setProc(13, { cmdline: argv, environ: marker });
    const outcome = observePostCoreCommand(child, "update");
    await vi.advanceTimersByTimeAsync(20);
    finish();
    const result = await outcome;
    expect(result.code).toBe(0);
    expect(result.children).toEqual([observed("11", argv, null), observed("13"), observed("12")]);
  });

  it("does not manufacture positive handoff evidence when cmdline is inaccessible", async () => {
    files.set("/proc/10/task/10/children", "11");
    setProc(11, { environ: "OPENCLAW_UPDATE_POST_CORE=0\0", cmdline: procError("EACCES") });
    const outcome = observePostCoreCommand(child, "update");
    await vi.advanceTimersByTimeAsync(20);
    finish();
    expect((await outcome).children.some((entry) => entry.postCore)).toBe(false);
  });

  it("retains positive evidence and worker argv after process.title changes and the process exits", async () => {
    for (const pid of [11, 12]) {
      setProc(pid, { cmdline: workerArgv });
    }
    const outcome = observePostCoreCommand(child, "update");
    await vi.advanceTimersByTimeAsync(20);
    setProc(11, { cmdline: "openclaw-update\0", environ: procError("EACCES") });
    files.set("/proc/12/cmdline", procError("ESRCH"));
    await vi.advanceTimersByTimeAsync(20);
    files.set("/proc/10/task/10/children", "");
    await vi.advanceTimersByTimeAsync(20);
    finish(7);
    const result = await outcome;
    expect(result.code).toBe(7);
    expect(result.children).toEqual(["11", "12"].map((pid) => observed(pid, workerArgv)));
  });

  it("joins unexpected observer failure with command exit instead of throwing from the timer", async () => {
    const failure = procError("EIO");
    files.set("/proc/11/environ", failure);
    const outcome = observePostCoreCommand(child, "update-denied");
    const rejected = expect(outcome).rejects.toMatchObject({
      message: "update-denied observation failed after command exit 7 (null)",
      cause: failure,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(child.listenerCount("exit")).toBe(1);
    finish(7);
    await rejected;
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("cleans up observation when command spawning fails", async () => {
    const failure = procError("ENOENT");
    const outcome = observePostCoreCommand(child, "update");
    const rejected = expect(outcome).rejects.toBe(failure);
    child.emit("error", failure);
    await rejected;
    expect(child.listenerCount("exit")).toBe(0);
  });
});

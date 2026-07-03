import { EventEmitter } from "node:events";
// Watch Node tests cover watch node script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWatchMain } from "../../scripts/watch-node.mjs";

class FakeProcess extends EventEmitter {
  execPath = process.execPath;
  pid = 12345;
  stdin = {
    isTTY: false,
  };
  stderr = {
    write: () => true,
  };
}

class FakeChild extends EventEmitter {
  signals: string[] = [];
  pid?: number;

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL") {
      this.emit("exit", null, "SIGKILL");
    }
    return true;
  }
}

describe("watch-node shutdown cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the child and escalates when interrupted children ignore SIGTERM", async () => {
    vi.useFakeTimers();
    const fakeProcess = new FakeProcess();
    const child = new FakeChild();
    let resolvedCode: number | undefined;

    const run = runWatchMain({
      args: ["gateway"],
      createWatcher: () => ({ close: async () => {}, on: () => {} }),
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: () => child as never,
    }).then((code) => {
      resolvedCode = code;
      return code;
    });

    fakeProcess.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolvedCode).toBeUndefined();
    expect(child.signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBe(143);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("force-cleans the child process group when the leader exits after shutdown", async () => {
    vi.useFakeTimers();
    const fakeProcess = new FakeProcess();
    const child = new FakeChild(4_242);
    const groupSignals: Array<[number, string | number]> = [];

    const run = runWatchMain({
      args: ["gateway"],
      createWatcher: () => ({ close: async () => {}, on: () => {} }),
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      signalProcess: (pid, signal) => {
        groupSignals.push([pid, signal]);
      },
      spawn: () => child as never,
    });

    fakeProcess.emit("SIGTERM");
    expect(groupSignals).toEqual([[-4_242, "SIGTERM"]]);
    child.emit("exit", 0, null);

    await expect(run).resolves.toBe(143);
    expect(groupSignals).toEqual([
      [-4_242, "SIGTERM"],
      [-4_242, "SIGKILL"],
    ]);
  });

  it("waits for the auto-doctor child when interrupted during repair", async () => {
    vi.useFakeTimers();
    const fakeProcess = new FakeProcess();
    const runner = new FakeChild();
    const doctor = new FakeChild();
    const children = [runner, doctor];
    let resolvedCode: number | undefined;

    const run = runWatchMain({
      args: ["gateway"],
      createWatcher: () => ({ close: async () => {}, on: () => {} }),
      env: {},
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: () => children.shift() as never,
    }).then((code) => {
      resolvedCode = code;
      return code;
    });

    runner.emit("exit", 1, null);
    expect(children).toHaveLength(0);

    fakeProcess.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolvedCode).toBeUndefined();
    expect(doctor.signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBe(143);
    expect(doctor.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

class FakeWatcher extends EventEmitter {
  async close() {}
}

describe("watch-node deferred restart on missing dist/entry.js", () => {
  let tmpDir: string;
  let child: FakeChild;
  let watcher: FakeWatcher;
  let fakeProcess: FakeProcess;

  afterEach(() => {
    vi.useRealTimers();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const startWatch = () => {
    child = new FakeChild();
    fakeProcess = new FakeProcess();
    watcher = new FakeWatcher();
    void runWatchMain({
      args: ["gateway"],
      cwd: tmpDir,
      createWatcher: () => watcher as never,
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: () => child as never,
    });
  };

  it("proceeds with restart when dist/entry.js exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "entry.js"), "// test entry");

    startWatch();
    expect(child.signals).toEqual([]);

    watcher.emit("change", "src/some-file.ts");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("defers restart when dist/entry.js is missing", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    startWatch();
    expect(child.signals).toEqual([]);

    watcher.emit("change", "src/some-file.ts");
    // Child should NOT have been killed — restart is deferred
    expect(child.signals).toEqual([]);
  });

  it("defers again when entry.js still missing after poll", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    startWatch();
    watcher.emit("change", "src/some-file.ts");
    expect(child.signals).toEqual([]); // deferred

    // Advance past poll interval — entry.js still missing
    await vi.advanceTimersByTimeAsync(2_001);
    expect(child.signals).toEqual([]); // still deferred, no restart
  });

  it("triggers deferred restart when entry.js appears", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    startWatch();
    watcher.emit("change", "src/some-file.ts");
    expect(child.signals).toEqual([]); // deferred

    // Create entry.js now
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "entry.js"), "// test entry");

    // Advance past poll interval
    await vi.advanceTimersByTimeAsync(2_001);
    expect(child.signals).toEqual(["SIGTERM"]); // deferred restart fired
  });

  it("shutdown during deferred state clears pending timer", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    startWatch();
    expect(child.signals).toEqual([]);

    // Enter deferred state
    watcher.emit("change", "src/some-file.ts");
    expect(child.signals).toEqual([]);

    // Shutdown while deferred — clears the pending timer
    fakeProcess.emit("SIGTERM");
    expect(child.signals).toEqual(["SIGTERM"]); // shutdown killed child

    // Advance past PENDING_RESTART_CHECK_MS — deferred timer was cleared,
    // so no additional restart signal
    await vi.advanceTimersByTimeAsync(2_001);
    expect(child.signals).toEqual(["SIGTERM"]);

    // Advance past shutdown kill grace
    await vi.advanceTimersByTimeAsync(3_001);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not restart when entry.js missing and child process already exited", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    const spawnCalls: number[] = [];
    child = new FakeChild();
    fakeProcess = new FakeProcess();
    watcher = new FakeWatcher();

    void runWatchMain({
      args: ["gateway"],
      cwd: tmpDir,
      createWatcher: () => watcher as never,
      env: { OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR: "0" },
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: () => {
        spawnCalls.push(1);
        return child as never;
      },
    });

    expect(spawnCalls).toHaveLength(1); // initial startRunner

    // Simulate child crash with non-restartable exit code
    child.emit("exit", 1, null);

    // Now watchProcess is null. Entry is still missing.
    // Emit change — should NOT call startRunner() again
    watcher.emit("change", "src/some-file.ts");
    expect(spawnCalls).toHaveLength(1); // still 1, no new spawn
  });
});

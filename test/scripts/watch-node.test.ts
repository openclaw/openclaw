import { EventEmitter } from "node:events";
// Watch Node tests cover watch node script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBuildReadyForRestart, runWatchMain } from "../../scripts/watch-node.mjs";

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

  it("proceeds with restart when dist/entry.js exists and build stamp is present", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "entry.js"), "// test entry");
    // Build stamp must exist so isBuildReadyForRestart checks pass
    fs.writeFileSync(
      path.join(tmpDir, "dist", ".buildstamp"),
      JSON.stringify({ head: "test-head", builtAt: Date.now() }) + "\n",
    );

    startWatch();
    expect(child.signals).toEqual([]);

    watcher.emit("change", "src/some-file.ts");
    expect(child.signals).toEqual(["SIGTERM"]);

    // Clean up: shut down the watch loop
    fakeProcess.emit("SIGTERM");
  });

  it("defers restart when dist/entry.js is missing", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    startWatch();
    expect(child.signals).toEqual([]);

    watcher.emit("change", "src/some-file.ts");
    // Child should NOT have been killed — restart is deferred
    expect(child.signals).toEqual([]);

    // Clean up: shut down the watch loop to clear the pending timer
    fakeProcess.emit("SIGTERM");
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

  it("triggers background rebuild spawn when entry.js is missing", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    const spawnArgs: Array<{ execPath: string; args: string[] }> = [];
    child = new FakeChild();
    fakeProcess = new FakeProcess();
    watcher = new FakeWatcher();

    void runWatchMain({
      args: ["gateway"],
      cwd: tmpDir,
      createWatcher: () => watcher as never,
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: (execPath: string, args: string[]) => {
        spawnArgs.push({ execPath, args });
        return child as never;
      },
    });

    // Initial startRunner spawn
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0].args).toContain("scripts/run-node.mjs");

    // File change with missing entry.js — triggers rebuild spawn
    watcher.emit("change", "src/some-file.ts");
    expect(spawnArgs).toHaveLength(2);
    expect(spawnArgs[1].args).toEqual(["scripts/tsdown-build.mjs", "--no-clean"]);

    // Clean up
    fakeProcess.emit("SIGTERM");
  });

  it("triggers deferred restart when background rebuild completes", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

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

    // File change with missing entry — triggers rebuild
    watcher.emit("change", "src/some-file.ts");
    expect(child.signals).toEqual([]); // deferred

    // Simulate rebuild child exiting with success (code 0)
    // The rebuild child is the same FakeChild; emit exit with code 0
    child.emit("exit", 0, null);

    // Deferred restart should fire: SIGTERM to the current watch process
    expect(child.signals).toEqual(["SIGTERM"]);

    // Clean up
    fakeProcess.emit("SIGTERM");
  });

  it("does not trigger rebuild twice for same stale build", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    const spawnCalls: number[] = [];
    child = new FakeChild();
    fakeProcess = new FakeProcess();
    watcher = new FakeWatcher();

    void runWatchMain({
      args: ["gateway"],
      cwd: tmpDir,
      createWatcher: () => watcher as never,
      lockDisabled: true,
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: () => {
        spawnCalls.push(1);
        return child as never;
      },
    });

    expect(spawnCalls).toHaveLength(1); // initial startRunner

    // Two file changes while entry.js missing
    watcher.emit("change", "src/some-file.ts");
    expect(spawnCalls).toHaveLength(2); // 1 rebuild + 1 initial

    watcher.emit("change", "src/another-file.ts");
    // Should NOT trigger another rebuild — already in progress
    expect(spawnCalls).toHaveLength(2);

    // Clean up
    fakeProcess.emit("SIGTERM");
  });

  it("triggers deferred restart when entry.js and build stamp appear", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));

    startWatch();
    watcher.emit("change", "src/some-file.ts");
    expect(child.signals).toEqual([]); // deferred

    // Create entry.js and build stamp now
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "entry.js"), "// test entry");
    fs.writeFileSync(
      path.join(tmpDir, "dist", ".buildstamp"),
      JSON.stringify({ head: "test-head", builtAt: Date.now() }) + "\n",
    );

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

  // ── isBuildReadyForRestart pure function tests ─────────────────────

  it("isBuildReadyForRestart returns false when entry.js does not exist", () => {
    const mockFs = { existsSync: vi.fn().mockReturnValue(false) };
    expect(isBuildReadyForRestart("/tmp/test-cwd", mockFs)).toBe(false);
    expect(mockFs.existsSync).toHaveBeenCalledWith("/tmp/test-cwd/dist/entry.js");
  });

  it("isBuildReadyForRestart returns true when entry exists and no readFileSync (fallback)", () => {
    const mockFs = { existsSync: vi.fn().mockReturnValue(true) };
    expect(isBuildReadyForRestart("/tmp/test-cwd", mockFs)).toBe(true);
  });

  it("isBuildReadyForRestart returns false when build stamp HEAD mismatches git HEAD", () => {
    const readFileSync = vi
      .fn()
      .mockReturnValue(
        JSON.stringify({ head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", builtAt: Date.now() }),
      );
    const mockFs = {
      existsSync: vi.fn((p: string) => p.includes("entry.js") || p.includes(".buildstamp")),
      readFileSync,
    };
    const mockResolveHead = vi.fn().mockReturnValue("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(isBuildReadyForRestart("/tmp/test-cwd", mockFs, mockResolveHead)).toBe(false);
    expect(mockResolveHead).toHaveBeenCalledWith({ cwd: "/tmp/test-cwd" });
  });

  it("isBuildReadyForRestart returns true when build stamp HEAD matches git HEAD", () => {
    const sharedHead = "cccccccccccccccccccccccccccccccccccccccc";
    const readFileSync = vi
      .fn()
      .mockReturnValue(JSON.stringify({ head: sharedHead, builtAt: Date.now() }));
    const mockFs = {
      existsSync: vi.fn((p: string) => p.includes("entry.js") || p.includes(".buildstamp")),
      readFileSync,
    };
    const mockResolveHead = vi.fn().mockReturnValue(sharedHead);
    expect(isBuildReadyForRestart("/tmp/test-cwd", mockFs, mockResolveHead)).toBe(true);
  });

  it("isBuildReadyForRestart returns false when build stamp file is missing (with readFileSync available)", () => {
    const readFileSync = vi.fn();
    const mockFs = {
      // entry.js exists, .buildstamp does NOT exist
      existsSync: vi.fn((p: string) => p.includes("entry.js") && !p.includes(".buildstamp")),
      readFileSync,
    };
    expect(isBuildReadyForRestart("/tmp/test-cwd", mockFs)).toBe(false);
  });

  it("isBuildReadyForRestart returns false when stamp exists but has no head field while current HEAD is known", () => {
    const readFileSync = vi.fn().mockReturnValue(JSON.stringify({ builtAt: Date.now() }));
    const mockFs = {
      existsSync: vi.fn((p: string) => p.includes("entry.js") || p.includes(".buildstamp")),
      readFileSync,
    };
    const mockResolveHead = vi.fn().mockReturnValue("dddddddddddddddddddddddddddddddddddddddd");
    expect(isBuildReadyForRestart("/tmp/test-cwd", mockFs, mockResolveHead)).toBe(false);
  });

  // ── Exit handler guard tests ──────────────────────────────────────

  it("does not restart after child SIGTERM exit when build not ready", () => {
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

    // Child exits with SIGTERM (restartable code 143) but build not ready (no entry.js)
    child.emit("exit", 143, null);

    // Should NOT spawn a new child — exit handler guard settles
    expect(spawnCalls).toHaveLength(1);
  });

  it("restarts after child SIGTERM exit when build is ready (guard does not block)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-node-test-"));
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "entry.js"), "// test entry");
    fs.writeFileSync(
      path.join(tmpDir, "dist", ".buildstamp"),
      JSON.stringify({ head: "test-head", builtAt: Date.now() }) + "\n",
    );

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

    // Child exits with SIGTERM but build IS ready — should restart
    child.emit("exit", 143, null);
    expect(spawnCalls).toHaveLength(2); // restart spawned
  });
});

import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { spawnCommand } from "./exec-spawn.js";
import { runWithSpawnBroker } from "./spawn-broker/context.js";
import { createSpawnBrokerHost } from "./spawn-broker/host.js";
import { emitChildProcessSpawnSample, recordChildProcessSpawn } from "./spawn-diagnostics.js";
import { spawnProcess, spawnWithFallback } from "./spawn-utils.js";

type SpawnImplementation = NonNullable<Parameters<typeof spawnWithFallback>[0]["spawnImpl"]>;

function createStubChild() {
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => {
    child.emit("spawn");
  });
  return child;
}

describe("spawnWithFallback", () => {
  it("retries on EBADF using fallback options", async () => {
    const spawnMock = vi
      .fn<SpawnImplementation>()
      .mockImplementationOnce(() => {
        const err = new Error("spawn EBADF");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      })
      .mockImplementationOnce(() => createStubChild());

    const result = await spawnWithFallback({
      argv: ["echo", "ok"],
      options: { stdio: ["pipe", "pipe", "pipe"] },
      fallbacks: [{ stdio: ["ignore", "pipe", "pipe"] }],
      spawnImpl: spawnMock,
    });

    expect(result.usedFallback).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[2].stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(spawnMock.mock.calls[1]?.[2].stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("does not retry on non-EBADF errors", async () => {
    const spawnMock = vi.fn().mockImplementationOnce(() => {
      const err = new Error("spawn ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    await expect(
      spawnWithFallback({
        argv: ["missing"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
        fallbacks: [{ stdio: ["ignore", "pipe", "pipe"] }],
        spawnImpl: spawnMock,
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not spawn a fallback after request authority retires during startup", async () => {
    let current = true;
    const retired = Object.assign(new Error("request authority retired"), { code: "EBADF" });
    const firstChild = createStubChild();
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockImplementation(() => createStubChild());
    const run = spawnWithFallback({
      argv: ["agent-cli"],
      options: {},
      fallbacks: [{ detached: false }, { stdio: "ignore" }],
      spawnImpl: spawnMock,
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    });
    const outcome = Promise.allSettled([run]);
    current = false;
    firstChild.emit("error", Object.assign(new Error("spawn EBADF"), { code: "EBADF" }));

    expect(await outcome).toEqual([{ status: "rejected", reason: retired }]);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("rejects ENOENT from a real missing executable", async () => {
    await withTempDir("openclaw-spawn-missing-", async (dir) => {
      await expect(
        spawnWithFallback({
          argv: [path.join(dir, "missing-executable")],
          options: { stdio: "ignore" },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("child-process spawn diagnostics", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let now: number;
  let events: DiagnosticEventPayload[];
  let stop: () => void;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    events = [];
    stop = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.child_process.spawn") {
        events.push(event);
      }
    });
  });

  afterEach(() => {
    stop();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  async function checkSuccessfulSpawns() {
    const missing = path.join(tempDirs.make("openclaw-spawn-counts-"), "missing");
    const child = spawnProcess(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect((await once(child, "close"))[0]).toBe(0);
    await expect(spawnCommand([process.execPath, "-e", ""])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      once(spawnProcess(missing, [], { stdio: "ignore" }), "close"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(spawnCommand([missing])).rejects.toMatchObject({ code: "ENOENT" });
    now = 59_999;
    emitChildProcessSpawnSample();
    expect(events).toEqual([]);
    now = 90_000;
    emitChildProcessSpawnSample();
    expect(events).toEqual([
      expect.objectContaining({ family: "node", count: 2, intervalMs: 90_000 }),
    ]);
    now = 150_000;
    emitChildProcessSpawnSample();
    expect(events).toHaveLength(1);
  }

  it(
    "counts successful native and command launches once, excluding failures",
    checkSuccessfulSpawns,
  );

  it.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
    "counts successful broker requests once without counting the broker transport",
    async () => {
      const host = createSpawnBrokerHost();
      try {
        await host.ready();
        await runWithSpawnBroker(host, checkSuccessfulSpawns);
      } finally {
        await host.close();
      }
    },
  );

  it("bounds labels to command families and discards disabled observations", () => {
    for (const command of ["/private/customer/helper-secret", "C:\\private\\Git.EXE"]) {
      const child = new EventEmitter() as ChildProcess;
      recordChildProcessSpawn(command, child);
      child.emit("spawn");
    }
    now = 60_000;
    emitChildProcessSpawnSample();
    expect(events).toEqual([
      expect.objectContaining({ family: "other", count: 1 }),
      expect.objectContaining({ family: "git", count: 1 }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private");

    const pending = new EventEmitter() as ChildProcess;
    recordChildProcessSpawn("node", pending);
    setDiagnosticsEnabledForProcess(false);
    pending.emit("spawn");
    recordChildProcessSpawn("node", pending);
    pending.emit("spawn");
    now = 120_000;
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    now = 180_000;
    emitChildProcessSpawnSample();
    expect(events).toHaveLength(2);
  });
});

// Plugin Lifecycle Probe tests cover QA Lab plugin lifecycle evidence.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as nativeProcessTick } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../../../scripts/lib/windows-taskkill.mjs";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  assertInspectDisabled,
  assertInspectLoaded,
  assertUninstalled,
  parseDurationMs,
  testing as probeTesting,
} from "./plugin-lifecycle-probe-runtime.js";

// Process reaping uses native time even while the command deadline uses fake timers.
const waitForProcessTick = nativeProcessTick;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Once the parent exits, its descendant has no ChildProcess handle in this test.
async function waitForProcessExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessRunning(pid)) {
      await waitForProcessTick(5, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`process still alive: ${pid}`, { cause: error });
    }
    throw error;
  }
}

class FakeCommandChild extends EventEmitter {
  readonly signals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    if (signal === "SIGTERM") {
      queueMicrotask(() => this.emit("exit", 0, null));
    }
    return true;
  }
}

describe("plugin lifecycle matrix probe", () => {
  it("accepts inspect JSON for an enabled loaded plugin", async () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-probe-");
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "loaded" } })}\n`,
      "utf8",
    );

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).not.toThrow();
  });

  it("accepts inspect JSON for a disabled plugin", async () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-probe-");
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: false, id: "lifecycle-claw", status: "disabled" } })}\n`,
      "utf8",
    );

    expect(() => assertInspectDisabled("lifecycle-claw", inspectPath)).not.toThrow();
  });

  it("rejects disabled inspect JSON that still reports a loaded plugin", async () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-probe-");
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: false, id: "lifecycle-claw", status: "loaded" } })}\n`,
      "utf8",
    );

    expect(() => assertInspectDisabled("lifecycle-claw", inspectPath)).toThrow(
      "expected lifecycle-claw inspect status disabled, got loaded",
    );
  });

  it("rejects inspect JSON that does not prove the runtime loaded", async () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-probe-");
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "pending" } })}\n`,
      "utf8",
    );

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).toThrow(
      "expected lifecycle-claw inspect status loaded, got pending",
    );
  });

  it("rejects missing inspect JSON instead of treating it as an empty object", async () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-probe-");
    const inspectPath = path.join(dir, "missing.json");

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).toThrow(
      `failed to read JSON from ${inspectPath}`,
    );
  });

  it("rejects unreadable config during uninstall proof", async () => {
    const dir = tempDirs.make("openclaw-plugin-lifecycle-probe-");
    const configFile = path.join(dir, ".openclaw", "openclaw.json");
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, "{ malformed\n", "utf8");

    expect(() =>
      assertUninstalled("lifecycle-claw", {
        HOME: dir,
        OPENCLAW_CONFIG_PATH: configFile,
      }),
    ).toThrow(`failed to read JSON from ${configFile}`);
  });

  it("preserves disabled npm install timeout semantics", () => {
    expect(parseDurationMs("0", "600s")).toBeUndefined();
  });

  it("rejects timed commands that exit cleanly during kill grace", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeCommandChild();
      const runPromise = probeTesting.runCommand("fake-command", ["install"], {
        spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
        timeoutKillGraceMs: 100,
        timeoutMs: 10,
      });
      const runError = runPromise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);

      const error = await runError;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("fake-command install timed out after 10ms");
      expect(child.signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(100);
      expect(child.signals).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-kills timed Windows commands with taskkill when graceful taskkill fails", async () => {
    vi.useFakeTimers();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const child = Object.assign(new FakeCommandChild(), { pid: 12345 });
      const taskkillImpl = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockImplementationOnce(() => {
          queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
          return { status: 0 };
        });
      const runPromise = probeTesting.runCommand("fake-command", ["install"], {
        spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
        taskkillImpl,
        timeoutKillGraceMs: 100,
        timeoutMs: 10,
      });
      const runError = runPromise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);

      expect(taskkillImpl).toHaveBeenNthCalledWith(
        1,
        expectedTaskkillPath(),
        ["/PID", "12345", "/T"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      expect(taskkillImpl).toHaveBeenNthCalledWith(
        2,
        expectedTaskkillPath(),
        ["/PID", "12345", "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      expect(child.signals).toEqual([]);

      const error = await runError;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("fake-command install timed out after 10ms");
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      vi.useRealTimers();
    }
  });

  it("keeps fallback SIGKILL armed for ignored-stdio descendants", async ({ signal }) => {
    if (process.platform === "win32") {
      return;
    }

    const dir = tempDirs.make("openclaw-plugin-lifecycle-probe-");
    const descendantPidPath = path.join(dir, "descendant.pid");
    let descendantPid: number | undefined;
    let parent: ChildProcess | undefined;
    let parentClosed: Promise<void> | undefined;
    let completed: Promise<unknown> | undefined;
    const childSpawner = { spawn };
    const observedSpawn = vi.spyOn(childSpawner, "spawn");
    vi.useFakeTimers();
    try {
      const childScript =
        "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);";
      const parentScript = [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        fixtureReceiptClientSource(receipts.endpoint),
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
        "child.unref();",
        "child.once('message', () => {",
        "  child.disconnect();",
        "  writeFileSync(process.env.OPENCLAW_TEST_DESCENDANT_PID, String(child.pid));",
        `  sendReceipt(${JSON.stringify(descendantPidPath)}, "ready");`,
        "});",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const run = probeTesting.runCommand(
        process.execPath,
        ["--input-type=module", "-e", parentScript],
        {
          env: { ...process.env, OPENCLAW_TEST_DESCENDANT_PID: descendantPidPath },
          spawnImpl: childSpawner.spawn,
          timeoutKillGraceMs: 100,
          timeoutMs: 500,
        },
      );
      completed = run.catch((error: unknown) => error);
      const spawned = observedSpawn.mock.results[0];
      if (spawned?.type !== "return") {
        throw new Error("Fixture command did not spawn");
      }
      parent = spawned.value;
      const child = parent;
      parentClosed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      // runCommand registered its exit listener before this observer, so the
      // fallback is tested only after the product handled the parent's exit.
      const parentExited = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
      void parentExited.catch(() => {});
      const settled = completed.then((error) => {
        // The receipt and command exit use different channels. Publication is
        // durable before sending ready, so a delayed receipt cannot lose the race.
        if (!existsSync(descendantPidPath) || !readFileSync(descendantPidPath, "utf8").trim()) {
          throw error instanceof Error
            ? error
            : new Error(`Timed out waiting for ${descendantPidPath}`, { cause: error });
        }
      });
      await withinTest(
        Promise.race([receipts.waitFor(descendantPidPath, "ready"), settled]),
        signal,
      );
      descendantPid = Number(readFileSync(descendantPidPath, "utf8"));

      // Readiness proves the descendant ignores SIGTERM before the timeout starts.
      await vi.advanceTimersByTimeAsync(500);
      await withinTest(
        awaitGateBeforeSettlement(
          parentExited,
          run,
          "Fixture parent did not exit during kill grace",
        ),
        signal,
      );
      await vi.advanceTimersByTimeAsync(100);
      await withinTest(waitForProcessExit(descendantPid, signal), signal);
      await vi.advanceTimersByTimeAsync(100);

      await expect(run).rejects.toThrow(/timed out after 500ms/u);

      expect(isProcessRunning(descendantPid)).toBe(false);
    } finally {
      descendantPid ??= existsSync(descendantPidPath)
        ? Number(readFileSync(descendantPidPath, "utf8"))
        : undefined;
      try {
        // These existing timers own group cleanup even if readiness never arrived.
        await vi.advanceTimersByTimeAsync(500 + 100 + 100);
        await completed;
      } finally {
        try {
          parent?.kill("SIGKILL");
          if (descendantPid && isProcessRunning(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
          }
          await parentClosed;
        } finally {
          vi.useRealTimers();
          observedSpawn.mockRestore();
        }
      }
    }
  });
});

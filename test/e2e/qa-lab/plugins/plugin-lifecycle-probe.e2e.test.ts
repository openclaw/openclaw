// Plugin Lifecycle Probe tests cover QA Lab plugin lifecycle evidence.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../../../scripts/lib/windows-taskkill.mjs";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  isProcessAlive as isProcessRunning,
  waitForProcessExit,
} from "../../../scripts/live-process-fixture.test-support.js";
import {
  assertInspectDisabled,
  assertInspectLoaded,
  assertUninstalled,
  parseDurationMs,
  testing as probeTesting,
} from "./plugin-lifecycle-probe-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.useRealTimers());

function inspectFile(plugin?: { enabled: boolean; status: string }) {
  const file = path.join(tempDirs.make("openclaw-plugin-lifecycle-probe-"), "inspect.json");
  if (plugin) {
    writeFileSync(
      file,
      `${JSON.stringify({ plugin: { id: "lifecycle-claw", ...plugin } })}\n`,
      "utf8",
    );
  }
  return file;
}

function fixtureTarball(prefix: string) {
  const dir = tempDirs.make(prefix);
  const tarball = path.join(dir, "fixture.tgz");
  writeFileSync(tarball, "fixture package");
  const packages: [string, string, string][] = [["registry-probe", "1.0.0", tarball]];
  return { dir, packages };
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

it("serves fixture packages after the registry reports its listening port", async ({ signal }) => {
  const { dir, packages } = fixtureTarball("openclaw-plugin-registry-ready-");
  const registry = await probeTesting.startNpmFixtureRegistry(dir, packages, process.env, signal);
  try {
    const response = await fetch(`${registry.env.NPM_CONFIG_REGISTRY}/registry-probe`, {
      signal,
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({
      name: "registry-probe",
      "dist-tags": { latest: "1.0.0" },
    });
  } finally {
    await registry.stop();
  }
});

it("joins registry cleanup when its startup is cancelled", async () => {
  const { dir, packages } = fixtureTarball("openclaw-plugin-registry-cancel-");
  const cancellation = new AbortController();
  cancellation.abort(new Error("registry startup cancelled"));
  await expect(
    probeTesting.startNpmFixtureRegistry(dir, packages, process.env, cancellation.signal),
  ).rejects.toMatchObject({ name: "AbortError", cause: cancellation.signal.reason });
});

it.each([
  ["loaded", true, "loaded", undefined],
  ["disabled", false, "disabled", undefined],
  [
    "disabled but loaded",
    false,
    "loaded",
    "expected lifecycle-claw inspect status disabled, got loaded",
  ],
  ["missing", true, undefined, "missing"],
] as const)("validates %s inspect JSON", (_name, enabled, status, error) => {
  const check = enabled ? assertInspectLoaded : assertInspectDisabled;
  const file = inspectFile(status === undefined ? undefined : { enabled, status });
  const result = expect(() => check("lifecycle-claw", file));
  if (error) {
    result.toThrow(error === "missing" ? `failed to read JSON from ${file}` : error);
  } else {
    result.not.toThrow();
  }
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

it.each([false, true])(
  "rejects timed commands after graceful exit or failed Windows taskkill (Windows: %s)",
  async (windows) => {
    vi.useFakeTimers();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (windows) {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    }
    try {
      const child = Object.assign(new FakeCommandChild(), windows ? { pid: 12345 } : {});
      const taskkillImpl = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockImplementationOnce(() => {
          queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
          return { status: 0 };
        });
      const runError = probeTesting
        .runCommand("fake-command", ["install"], {
          spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
          ...(windows ? { taskkillImpl } : {}),
          timeoutKillGraceMs: 100,
          timeoutMs: 10,
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      const error = await runError;
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("message", "fake-command install timed out after 10ms");
      if (windows) {
        for (const [index, args] of [
          ["/PID", "12345", "/T"],
          ["/PID", "12345", "/T", "/F"],
        ].entries()) {
          expect(taskkillImpl).toHaveBeenNthCalledWith(
            index + 1,
            resolveWindowsTaskkillPath(),
            args,
            { stdio: "ignore", windowsHide: true },
          );
        }
        expect(child.signals).toEqual([]);
      } else {
        expect(child.signals).toEqual(["SIGTERM"]);
        await vi.advanceTimersByTimeAsync(100);
        expect(child.signals).toEqual(["SIGTERM"]);
      }
    } finally {
      if (windows && platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  },
);

it("keeps fallback SIGKILL armed for ignored-stdio descendants", async ({
  signal,
  onTestFinished,
}) => {
  if (process.platform === "win32") {
    return;
  }

  const receipts = await openFixtureReceiptChannel();
  onTestFinished(() => receipts.close());
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
    await withinTest(Promise.race([receipts.waitFor(descendantPidPath, "ready"), settled]), signal);
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));

    // Readiness proves the descendant ignores SIGTERM before the timeout starts.
    await vi.advanceTimersByTimeAsync(500);
    await withinTest(
      awaitGateBeforeSettlement(parentExited, run, "Fixture parent did not exit during kill grace"),
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

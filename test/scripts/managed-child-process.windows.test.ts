import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stopChild } from "../../scripts/lib/gateway-bench-child.ts";
import {
  inspectManagedProcessGroup,
  loadManagedChildSpawner,
  runManagedCommand,
  terminateManagedChild,
} from "../../scripts/lib/managed-child-process.mts";
import type { ManagedWindowsJob } from "../../scripts/lib/managed-windows-job.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createWindowsJobBindings } from "../../src/process/supervisor/service-child-windows-job-native.js";
import { testing } from "../helpers/openclaw-test-instance.js";
import { waitForFile } from "../helpers/process-wait.js";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const fault = vi.hoisted(() => {
  const state: { child?: ChildProcess; job?: ManagedWindowsJob; stop?: () => void } = {};
  return state;
});
vi.mock("../../scripts/lib/managed-windows-job.mts", async (original) => {
  const actual = await original<typeof import("../../scripts/lib/managed-windows-job.mts")>();
  return {
    ...actual,
    spawnWindowsJobChild: (...args: Parameters<typeof actual.spawnWindowsJobChild>) => {
      const owned = actual.spawnWindowsJobChild(...args);
      if (owned) {
        Object.assign(fault, owned, { stop: owned.job.stop });
        owned.job.stop = vi.fn(() => {});
      }
      return owned;
    },
  };
});
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform === "win32")(
  "retains the benchmark termination receipt on the original Windows child",
  async ({ signal }) => {
    const child = spawnChild(
      process.execPath,
      ["-e", 'process.on("message", () => {}); process.send("ready");'],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const closed = once(child, "close");
    void closed.catch(() => {});
    try {
      expect((await once(child, "message", { signal }))[0]).toBe("ready");
      expect(await stopChild(child)).toMatchObject({ exitedBeforeTeardown: false });
      await closed;
      expect(inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })).toBe("dead");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        terminateManagedChild(child, "SIGKILL");
      }
      await closed;
    }
  },
);

it.runIf(process.platform === "win32")(
  "releases an already-exited Gateway's native Job through the Gateway helper",
  async ({ signal }) => {
    const spawn = await loadManagedChildSpawner();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close", { signal });
    child.stdout.resume();
    child.stderr.resume();
    const job = fault.job;
    if (!job) {
      throw new Error("Windows Job launcher was not created");
    }
    const close = vi.spyOn(job, "close");
    try {
      await closed;
      await expect(testing.stopGatewayProcess(child, Date.now() + 5_000, 2_000)).resolves.toBe(
        true,
      );
      expect(close).toHaveBeenCalledOnce();
      expect(() => job.inspect()).toThrow("Windows command Job is closed");
    } finally {
      job.close();
    }
  },
);

it.runIf(process.platform === "win32").each(["abort", "normal exit"])(
  "joins native Job descendants with independent output after %s",
  { timeout: 30_000 },
  async (mode) => {
    const koffi = (await import("koffi")).default;
    createWindowsJobBindings(koffi).assertLayouts();
    createWindowsJobBindings(koffi).assertLayouts();
    const root = dirs.make("windows-job-survivor-");
    const ready = path.join(root, "ready");
    const owner = createVitestResourceOwner(root);
    const warning = createDeferred<Error>();
    vi.spyOn(process, "emitWarning").mockImplementation((value) => {
      if (value instanceof Error && "survivingPids" in value) {
        warning.resolve(value);
      }
    });
    const abort = new AbortController();
    let commandPid = 0;
    let terminated = false;
    let leaderClosed: Promise<unknown> | undefined;
    const command = runManagedCommand({
      bin: process.execPath,
      args: [
        "-e",
        `
const fs = require("node:fs");
const {spawn} = require("node:child_process");
const out = fs.openSync(process.argv[1] + ".output", "w");
// Escape libuv's kill-on-parent-exit Job while retaining OpenClaw's outer Job.
const descendant = spawn(process.execPath, ["-e", 'setInterval(() => process.stdout.write("."), 100)'], {detached:true,stdio:["ignore",out,out]});
fs.closeSync(out);
fs.writeFileSync(process.argv[1] + ".tmp", process.pid + " " + descendant.pid);
fs.renameSync(process.argv[1] + ".tmp", process.argv[1]);
${mode === "normal exit" ? 'process.stdin.once("data", () => process.exit(0));' : "setInterval(() => {}, 1000);"}
`,
        ready,
      ],
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
      shell: false,
      signal: abort.signal,
      onReady: (child) => {
        leaderClosed = once(child, "close");
        void leaderClosed.catch(() => {});
      },
      runTaskkill: () => {
        if (!terminated) {
          terminated = true;
          expect(fault.job?.inspect()).toContain(commandPid);
          process.kill(commandPid, "SIGKILL");
          fault.child?.kill("SIGKILL");
        }
        return { status: 255, stdout: "leader exited", stderr: "injected taskkill failure" };
      },
    });
    const outcome = command.catch((error: unknown) => error);
    try {
      await Promise.race([
        waitForFile(ready, 10_000),
        outcome.then((error) => {
          throw new Error("command completed before descendant readiness", { cause: error });
        }),
      ]);
      const pids = (await fs.readFile(ready, "utf8")).trim().split(/\s+/u).map(Number);
      const descendantPid = pids[1] ?? 0;
      commandPid = pids[0] ?? 0;
      expect(Number.isSafeInteger(commandPid) && commandPid > 1).toBe(true);
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 1).toBe(true);
      if (!fault.child) {
        throw new Error("Windows Job launcher was not created");
      }
      if (mode === "abort") {
        abort.abort();
      } else {
        if (!fault.child.stdin) {
          throw new Error("Native fixture control input is missing");
        }
        fault.child.stdin.end("exit\n");
      }
      const observation = await Promise.race([
        warning.promise,
        outcome.then((error) => {
          throw new Error("cleanup settled before recording the surviving descendant", {
            cause: error,
          });
        }),
      ]);
      await leaderClosed;
      expect(fault.child.stdout?.closed && fault.child.stderr?.closed).toBe(true);
      expect(fault.job?.stop).toHaveBeenCalled();
      expect(fault.job?.inspect()).toContain(descendantPid);
      expect(observation).toMatchObject({
        processTreeState: "indeterminate",
        survivingPids: expect.arrayContaining([descendantPid]),
      });
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    } finally {
      if (fault.job && fault.stop) {
        fault.job.stop = fault.stop;
        fault.stop();
      }
      if (mode === "abort") {
        abort.abort();
      }
      await outcome;
    }
    if (mode === "abort") {
      expect(await outcome).toMatchObject({ code: "ABORT_ERR" });
    } else {
      expect(await outcome).toBe(0);
    }
    owner.assertReleased();
  },
);

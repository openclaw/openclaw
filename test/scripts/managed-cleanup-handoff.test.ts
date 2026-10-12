import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

async function stopRecordedPid(pid: number, signal: AbortSignal) {
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
    }
  }
  await waitForDead(pid, signal);
}

function readSpawnedPids(record: string): number[] {
  if (!fs.existsSync(record)) {
    return [];
  }
  return fs
    .readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const pid = Number(line);
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error(`Invalid fixture PID in ${record}`);
      }
      return pid;
    });
}

describe.skipIf(process.platform === "win32")("managed cleanup ownership handoff", () => {
  it.for(["acknowledge", "cancel"] as const)(
    "holds concurrent command admission until the parent can %s ownership",
    async (action, { signal }) => {
      await fixture.run(async () => {
        const cwd = fixture.createTempDir("managed-handoff-admission-");
        const childPath = path.join(cwd, "owner.mjs");
        const spawnRecord = path.join(cwd, "spawned-pids");
        const invocationPaths = [0, 1].map((index) => path.join(cwd, `invocation-${index}.json`));
        const streamPaths = [0, 1].map((index) => path.join(cwd, `streams-${index}.json`));
        const leaf = `const fs = require("node:fs");
fs.writeFileSync(process.env.HANDOFF_RECORD, JSON.stringify({
  args: process.argv.slice(1), value: process.env.HANDOFF_INPUT,
}));
`;
        fs.writeFileSync(
          childPath,
          `import fs from "node:fs";
import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
const invocationPaths = ${JSON.stringify(invocationPaths)};
const streamPaths = ${JSON.stringify(streamPaths)};
const commands = [0, 1].map(index => {
  const args = ["-e", ${JSON.stringify(leaf)}, String(index)];
  const env = { ...process.env, HANDOFF_INPUT: "original-" + index, HANDOFF_RECORD: invocationPaths[index] };
  const stdio = index === 0 ? ["ignore"] : ["ignore", "pipe", "pipe"];
  const command = runManagedCommand({
    bin: process.execPath, args, env, stdio,
    onReady(child) {
      fs.appendFileSync(${JSON.stringify(spawnRecord)}, String(child.pid) + "\\n");
      fs.writeFileSync(streamPaths[index], JSON.stringify({ stdout: child.stdout !== null, stderr: child.stderr !== null }));
      child.stdout?.resume();
      child.stderr?.resume();
    },
  });
  if (${action === "acknowledge"}) {
    args[2] = "mutated-" + index;
    env.HANDOFF_INPUT = "mutated-" + index;
    stdio[1] = stdio[2] = "ignore";
  }
  return command;
});
fs.writeSync(1, "claims-requested\\n");
const statuses = await Promise.all(commands);
fs.writeSync(1, "completed " + JSON.stringify(statuses) + "\\n");
process.exitCode = statuses.find(code => code !== 0) ?? 0;
`,
        );
        const requested = createDeferred();
        const cancellation = new AbortController();
        let child: ChildProcess | undefined;
        let handoff: Socket | undefined;
        const completion = runNodeScript(childPath, process.env, undefined, {
          cwd,
          signal: cancellation.signal,
          maxBuffer: 64 * 1024,
          onReady(owned, readOutput) {
            child = owned;
            // The helper supplied three standard descriptors. Hold the real owner's
            // private channel before it can acknowledge either nested command.
            const channel = owned.stdio[3];
            if (!(channel instanceof Socket)) {
              throw new Error("Managed command did not supply its private control socket");
            }
            handoff = channel;
            channel.pause();
            owned.stdout!.on("data", () => {
              if (readOutput().stdout.includes("claims-requested\n")) {
                requested.resolve();
              }
            });
          },
        });
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              requested.promise,
              completion,
              "nested commands did not request ownership",
            ),
            signal,
          );
          // onReady records synchronously at spawn, so the child's marker proves
          // both callers returned pending without creating an unowned command.
          expect(readSpawnedPids(spawnRecord)).toEqual([]);
          if (action === "cancel") {
            cancellation.abort();
          }
          handoff!.resume();
          const result = await withinTest(completion, signal);
          if (action === "cancel") {
            expect(result.error, result.stderr).toMatchObject({ code: "ABORT_ERR" });
            expect(result.status).toBeNull();
            expect(result.stdout).toContain("completed [143,143]\n");
            expect(readSpawnedPids(spawnRecord)).toEqual([]);
          } else {
            expect(result.error, result.stderr).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toContain("completed [0,0]\n");
            expect(readSpawnedPids(spawnRecord)).toHaveLength(2);
            for (const index of [0, 1]) {
              expect(JSON.parse(fs.readFileSync(invocationPaths[index]!, "utf8"))).toEqual({
                args: [String(index)],
                value: `original-${index}`,
              });
              expect(JSON.parse(fs.readFileSync(streamPaths[index]!, "utf8"))).toEqual({
                stdout: true,
                stderr: true,
              });
            }
          }
          expect(readSpawnedPids(spawnRecord).filter(isProcessAlive)).toEqual([]);
          expect(isProcessAlive(child!.pid!)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            handoff?.resume();
            const cleanupSignal = AbortSignal.timeout(5_000);
            // Fence the only PID-record producer before reading its final records.
            if (child?.pid) {
              await stopRecordedPid(child.pid, cleanupSignal);
            }
            for (const pid of readSpawnedPids(spawnRecord)) {
              await stopRecordedPid(pid, cleanupSignal);
            }
            await completion;
          });
        }
      });
    },
  );

  it.for(["concurrent", "terminal", "release", "release-timeout"] as const)(
    "preserves %s outcomes while cleanup acknowledgements are pending",
    async (mode, { signal }) => {
      await fixture.run(async () => {
        const releasing = mode === "release" || mode === "release-timeout";
        const cwd = fixture.createTempDir("managed-handoff-abort-");
        const resourceOwner = createVitestResourceOwner(cwd);
        const childPath = path.join(cwd, "owner.mjs");
        const spawnRecord = path.join(cwd, "spawned-pids");
        fs.writeFileSync(
          childPath,
          releasing
            ? `import fs from "node:fs";
import { once } from "node:events";
import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
const scheduleTimeout = globalThis.setTimeout;
let expire;
if (${mode === "release-timeout"}) {
  // Drive only command expiry after readiness; cleanup retains real timers and time.
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 1) {
      globalThis.setTimeout = scheduleTimeout;
      expire = () => callback(...args);
      return undefined;
    }
    return scheduleTimeout(callback, delay, ...args);
  };
}
let leaf;
const command = runManagedCommand({
  bin: process.execPath, args: ["-e", "process.stdin.resume()"],
  stdio: ["pipe", "ignore", "ignore"], timeoutMs: ${mode === "release-timeout" ? "1" : "undefined"},
  onReady(child) {
    leaf = child;
    fs.appendFileSync(${JSON.stringify(spawnRecord)}, String(child.pid) + "\\n");
    child.once("close", () => fs.writeSync(1, "leaf-closed\\n"));
    fs.writeSync(1, "claims-requested\\n");
  },
}).then(status => ({ status }), error => ({
  error: { code: error.code },
}));
await once(process.stdin, "data");
if (expire) expire();
else leaf.stdin.end();
fs.writeSync(1, "settled " + JSON.stringify([await command]) + "\\n");
fs.writeSync(1, "completed []\\n");
`
            : `import fs from "node:fs";
import { once } from "node:events";
import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
const preaborted = new AbortController();
preaborted.abort();
const pending = new AbortController();
const run = (signal) => runManagedCommand({
  bin: process.execPath, args: ["-e", ""], stdio: "ignore", signal,
  onReady(child) { fs.appendFileSync(${JSON.stringify(spawnRecord)}, String(child.pid) + "\\n"); },
});
const cancelled = Promise.all([preaborted, pending].map(controller =>
  run(controller.signal).then(status => ({ status }), error => ({
    error: { code: error.code, reasonMatches: error === controller.signal.reason },
  })),
));
const sibling = ${mode === "concurrent"} ? run() : undefined;
const abort = once(process.stdin, "data");
fs.writeSync(1, "claims-requested\\n");
await abort;
pending.abort();
fs.writeSync(1, "settled " + JSON.stringify(await cancelled) + "\\n");
const statuses = sibling ? [await sibling, await run()] : [];
fs.writeSync(1, "completed " + JSON.stringify(statuses) + "\\n");
process.exitCode = statuses.find(code => code !== 0) ?? 0;
`,
        );
        const requested = createDeferred();
        const settled = createDeferred();
        const exited = createDeferred();
        const leafClosed = createDeferred();
        let child: ChildProcess | undefined;
        let handoff: Socket | undefined;
        let stdout = "";
        let stderr = "";
        const completion = runManagedCommand({
          bin: process.execPath,
          args: [childPath],
          cwd,
          env: { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd },
          stdio: ["pipe", "pipe", "pipe"],
          onReady(owned) {
            child = owned;
            owned.once("exit", () => exited.resolve());
            const channel = owned.stdio[3];
            if (!(channel instanceof Socket)) {
              throw new Error("Managed command did not supply its private control socket");
            }
            handoff = channel;
            if (!releasing) {
              channel.pause();
            }
            owned.stdout!.on("data", (chunk) => {
              stdout += String(chunk);
              if (stdout.includes("claims-requested\n")) {
                requested.resolve();
              }
              if (stdout.includes("leaf-closed\n")) {
                leafClosed.resolve();
              }
              if (/settled [^\n]*\n/u.test(stdout)) {
                settled.resolve();
              }
            });
            owned.stderr!.on("data", (chunk) => (stderr += String(chunk)));
          },
        }).then(
          (status) => ({ status }),
          (error: unknown) => ({ error }),
        );
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              requested.promise,
              completion,
              "commands did not request custody",
            ),
            signal,
          );
          if (releasing) {
            handoff!.pause();
            child!.stdin!.end("finish\n");
            await withinTest(
              awaitGateBeforeSettlement(
                leafClosed.promise,
                completion,
                "nested command did not exit",
              ),
              signal,
            );
          } else {
            child!.stdin!.end("abort\n");
          }
          await withinTest(
            awaitGateBeforeSettlement(
              settled.promise,
              completion,
              "command outcomes did not settle without acknowledgement",
            ),
            signal,
          );
          expect(stdout).toContain(
            mode === "release"
              ? 'settled [{"status":0}]\n'
              : mode === "release-timeout"
                ? 'settled [{"error":{"code":"ETIMEDOUT"}}]\n'
                : 'settled [{"error":{"code":20,"reasonMatches":true}},{"error":{"code":"ABORT_ERR","reasonMatches":false}}]\n',
          );
          expect(readSpawnedPids(spawnRecord)).toHaveLength(releasing ? 1 : 0);
          expect(readSpawnedPids(spawnRecord).filter(isProcessAlive)).toEqual([]);
          if (mode !== "concurrent") {
            // Joined or never-started work must exit without an ACK keeping the socket alive.
            await withinTest(
              awaitGateBeforeSettlement(exited.promise, completion, "settled owner did not exit"),
              signal,
            );
            expect(isProcessAlive(child!.pid!)).toBe(false);
          }
          handoff!.resume();
          expect(await withinTest(completion, signal), stderr).toEqual({ status: 0 });
          expect(stdout).toContain(`completed ${mode === "concurrent" ? "[0,0]" : "[]"}\n`);
          expect(readSpawnedPids(spawnRecord)).toHaveLength(
            mode === "concurrent" ? 2 : releasing ? 1 : 0,
          );
          expect(readSpawnedPids(spawnRecord).filter(isProcessAlive)).toEqual([]);
          expect(isProcessAlive(child!.pid!)).toBe(false);
          resourceOwner.assertReleased();
        } finally {
          await fixture.verifyCleanup(async () => {
            handoff?.resume();
            const cleanupSignal = AbortSignal.timeout(5_000);
            if (child?.pid) {
              await stopRecordedPid(child.pid, cleanupSignal);
            }
            for (const pid of readSpawnedPids(spawnRecord)) {
              await stopRecordedPid(pid, cleanupSignal);
            }
            await completion;
          });
        }
      });
    },
  );

  it("releases completed command custody before an idle implementation receives SIGTERM", async ({
    signal,
  }) => {
    await fixture.run(async () => {
      const cwd = fixture.createTempDir("managed-handoff-idle-");
      const resourceOwner = createVitestResourceOwner(cwd);
      const childPath = path.join(cwd, "owner.mjs");
      const spawnRecord = path.join(cwd, "spawned-pids");
      fs.writeFileSync(
        childPath,
        `import fs from "node:fs";
import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
const status = await runManagedCommand({
  bin: process.execPath, args: ["-e", ""], stdio: "ignore",
  onReady(child) { fs.appendFileSync(${JSON.stringify(spawnRecord)}, String(child.pid) + "\\n"); },
});
if (status !== 0) throw new Error("initial command failed: " + status);
fs.writeSync(1, "between-commands-ready\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`,
      );
      const idle = createDeferred();
      let child: ChildProcess | undefined;
      const completion = runNodeScript(
        childPath,
        { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd },
        undefined,
        {
          cwd,
          maxBuffer: 64 * 1024,
          onReady(owned, readOutput) {
            child = owned;
            owned.stdout!.on("data", () => {
              if (readOutput().stdout.includes("between-commands-ready\n")) {
                idle.resolve();
              }
            });
          },
        },
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(idle.promise, completion, "initial command did not join"),
          signal,
        );
        expect(readSpawnedPids(spawnRecord)).toHaveLength(1);
        expect(readSpawnedPids(spawnRecord).filter(isProcessAlive)).toEqual([]);
        expect(child!.kill("SIGTERM")).toBe(true);
        const result = await withinTest(completion, signal);
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(143);
        expect(isProcessAlive(child!.pid!)).toBe(false);
        expect(readSpawnedPids(spawnRecord).filter(isProcessAlive)).toEqual([]);
        resourceOwner.assertReleased();
      } finally {
        await fixture.verifyCleanup(async () => {
          const cleanupSignal = AbortSignal.timeout(5_000);
          if (child?.pid) {
            await stopRecordedPid(child.pid, cleanupSignal);
          }
          for (const pid of readSpawnedPids(spawnRecord)) {
            await stopRecordedPid(pid, cleanupSignal);
          }
          await completion;
        });
      }
    });
  });

  it("reclaims acknowledged custody before starting a later command", async ({ signal }) => {
    await fixture.run(async () => {
      const cwd = fixture.createTempDir("managed-handoff-reclaim-");
      const resourceOwner = createVitestResourceOwner(cwd);
      const childPath = path.join(cwd, "owner.mjs");
      const spawnRecord = path.join(cwd, "spawned-pids");
      fs.writeFileSync(
        childPath,
        `import fs from "node:fs";
import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
const run = () => runManagedCommand({
  bin: process.execPath, args: ["-e", ""], stdio: "ignore",
  onReady(child) { fs.appendFileSync(${JSON.stringify(spawnRecord)}, String(child.pid) + "\\n"); },
});
if (await run() !== 0) throw new Error("initial command failed");
const continued = new Promise(resolve => process.stdin.once("data", resolve));
fs.writeSync(1, "between-commands-ready\\n");
await continued;
const second = run();
fs.writeSync(1, "reclaim-requested\\n");
process.exitCode = await second;
`,
      );
      const idle = createDeferred();
      const requested = createDeferred();
      let child: ChildProcess | undefined;
      let handoff: Socket | undefined;
      let stdout = "";
      let stderr = "";
      const completion = runManagedCommand({
        bin: process.execPath,
        args: [childPath],
        cwd,
        env: { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd },
        stdio: ["pipe", "pipe", "pipe"],
        onReady(owned) {
          child = owned;
          const channel = owned.stdio[3];
          if (!(channel instanceof Socket)) {
            throw new Error("Managed command did not supply its private control socket");
          }
          handoff = channel;
          owned.stdout!.on("data", (chunk) => {
            stdout += String(chunk);
            if (stdout.includes("between-commands-ready\n")) {
              idle.resolve();
            }
            if (stdout.includes("reclaim-requested\n")) {
              requested.resolve();
            }
          });
          owned.stderr!.on("data", (chunk) => (stderr += String(chunk)));
        },
      }).then(
        (status) => ({ status }),
        (error: unknown) => ({ error }),
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(idle.promise, completion, "initial command did not join"),
          signal,
        );
        expect(readSpawnedPids(spawnRecord)).toHaveLength(1);
        handoff!.pause();
        child!.stdin!.end("continue\n");
        await withinTest(
          awaitGateBeforeSettlement(
            requested.promise,
            completion,
            "later command was not requested",
          ),
          signal,
        );
        expect(readSpawnedPids(spawnRecord)).toHaveLength(1);
        handoff!.resume();
        expect(await withinTest(completion, signal), stderr).toEqual({ status: 0 });
        expect(readSpawnedPids(spawnRecord)).toHaveLength(2);
        expect(readSpawnedPids(spawnRecord).filter(isProcessAlive)).toEqual([]);
        expect(isProcessAlive(child!.pid!)).toBe(false);
        resourceOwner.assertReleased();
      } finally {
        await fixture.verifyCleanup(async () => {
          handoff?.resume();
          const cleanupSignal = AbortSignal.timeout(5_000);
          if (child?.pid) {
            await stopRecordedPid(child.pid, cleanupSignal);
          }
          for (const pid of readSpawnedPids(spawnRecord)) {
            await stopRecordedPid(pid, cleanupSignal);
          }
          await completion;
        });
      }
    });
  });

  it("bounds unresponsive delegated custody without killing its acknowledged owner", async ({
    signal,
  }) => {
    await fixture.run(async () => {
      const cwd = fixture.createTempDir("managed-handoff-unresponsive-");
      const resourceOwner = createVitestResourceOwner(cwd);
      const ownerPath = path.join(cwd, "owner.mjs");
      const supervisorPath = path.join(cwd, "supervisor.mjs");
      const ownerPidPath = path.join(cwd, "owner.pid");
      const reportPath = path.join(cwd, "result.json");
      fs.writeFileSync(
        ownerPath,
        `import fs from "node:fs";
import { claimManagedCleanup } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-cleanup-handoff.mts")).href)};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
await claimManagedCleanup();
fs.writeSync(1, "unresponsive-owner-ready\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`,
      );
      fs.writeFileSync(
        supervisorPath,
        `import fs from "node:fs";
import { runManagedCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href)};
// Only the supervisor's existing cancellation budget is accelerated.
const realNow = Date.now.bind(Date);
const startedAt = realNow();
Date.now = () => startedAt + (realNow() - startedAt) * 20;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay / 20, ...args);
let report;
try {
  report = { status: await runManagedCommand({
    bin: process.execPath,
    args: [${JSON.stringify(ownerPath)}],
    stdio: "inherit",
    onReady(child) { fs.writeFileSync(${JSON.stringify(ownerPidPath)}, String(child.pid)); },
  }) };
} catch (error) {
  report = { error: { code: error.code, message: error.message, processTreeState: error.processTreeState } };
}
fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));
process.exitCode = report.error ? 1 : report.status;
`,
      );
      const ready = createDeferred();
      // A native parent observes whether the actual CLI can exit after reporting
      // failed custody; no outer managed finalizer can rescue its retained handles.
      const supervisor = spawn(process.execPath, [supervisorPath], {
        cwd,
        env: { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const completion = once(supervisor, "close");
      let stdout = "";
      let stderr = "";
      supervisor.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("unresponsive-owner-ready\n")) {
          ready.resolve();
        }
      });
      supervisor.stderr.on("data", (chunk) => (stderr += String(chunk)));
      try {
        await withinTest(
          awaitGateBeforeSettlement(ready.promise, completion, "owner did not accept custody"),
          signal,
        );
        const [ownerPid] = readSpawnedPids(ownerPidPath);
        expect(isProcessAlive(ownerPid!)).toBe(true);
        expect(supervisor.kill("SIGTERM")).toBe(true);
        expect(await withinTest(completion, signal), stderr).toEqual([1, null]);
        expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toMatchObject({
          error: { code: "EPROCESSGROUP_CLEANUP_FAILED", processTreeState: "indeterminate" },
        });
        // Unresolved handoff is a retained failure, never permission to force-kill
        // the acknowledged owner or certify its potentially detached work as dead.
        expect(isProcessAlive(ownerPid!)).toBe(true);
        expect(() => resourceOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      } finally {
        await fixture.verifyCleanup(async () => {
          const cleanupSignal = AbortSignal.timeout(5_000);
          if (supervisor.pid) {
            await stopRecordedPid(supervisor.pid, cleanupSignal);
          }
          for (const pid of readSpawnedPids(ownerPidPath)) {
            await stopRecordedPid(pid, cleanupSignal);
          }
          await completion;
        });
      }
    });
  });

  it("retains the resource claim when an acknowledged owner loses its control channel", async ({
    signal,
  }) => {
    await fixture.run(async () => {
      const cwd = fixture.createTempDir("managed-handoff-owner-loss-");
      const resourceOwner = createVitestResourceOwner(cwd);
      const childPath = path.join(cwd, "owner.mjs");
      fs.writeFileSync(
        childPath,
        `import fs from "node:fs";
import { claimManagedCleanup } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/managed-cleanup-handoff.mts")).href)};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
await claimManagedCleanup();
fs.writeSync(1, "ownership-accepted\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`,
      );
      const accepted = createDeferred();
      let child: ChildProcess | undefined;
      const completion = runNodeScript(
        childPath,
        { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd },
        undefined,
        {
          cwd,
          maxBuffer: 64 * 1024,
          onReady(owned, readOutput) {
            child = owned;
            owned.stdout!.on("data", () => {
              if (readOutput().stdout.includes("ownership-accepted\n")) {
                accepted.resolve();
              }
            });
          },
        },
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            accepted.promise,
            completion,
            "cleanup owner did not receive acknowledgement",
          ),
          signal,
        );
        // Kill the acknowledged process before its exit handler can relinquish
        // ownership. The real pipe closes; no protocol frame is forged or omitted.
        expect(child!.kill("SIGKILL")).toBe(true);
        const result = await withinTest(completion, signal);
        expect(result.error, result.stderr).toMatchObject({
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: "indeterminate",
        });
        expect(result.status).toBeNull();
        expect(isProcessAlive(child!.pid!)).toBe(false);
        expect(() => resourceOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      } finally {
        await fixture.verifyCleanup(async () => {
          // This fixture creates only the recorded child. Its independent kernel
          // census permits teardown while preserving the asserted failed receipt.
          if (child?.pid) {
            await stopRecordedPid(child.pid, AbortSignal.timeout(5_000));
          }
          await completion;
        });
      }
    });
  });
});

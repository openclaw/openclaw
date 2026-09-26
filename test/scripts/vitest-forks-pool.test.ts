import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.ts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runVitestShutdownCommand } from "../helpers/vitest-shutdown-command.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());
const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixNodeIt = it.skipIf(process.platform === "win32" || Boolean(process.versions.bun));
const teardownTimeoutError = "[vitest-pool-runner]: Timeout waiting for worker to respond";

posixNodeIt.for([
  "normal",
  "write-failure",
  "missing-ack",
  "after-ack",
  "blocked-after-ack",
  "exit-listener",
] as const)(
  "retains native fork cleanup and captures only stalled teardown (%s)",
  { timeout: 180_000 },
  (mode, { signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const root = fixture.createTempDir("openclaw-pool-diagnostics-");
      const home = path.join(root, "home");
      const tmp = path.join(root, "tmp");
      fs.mkdirSync(home);
      fs.mkdirSync(tmp);
      fs.symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","private":true}');
      const receipt = path.join(root, "deadline.json");
      const diagnosticReceipt = path.join(root, "diagnostic-deadline.json");
      const preload = path.join(root, "hold-teardown.cjs");
      fs.writeFileSync(
        preload,
        `
const { subscribe } = require("node:diagnostics_channel");
const fs = require("node:fs");
const mode = ${JSON.stringify(mode)};
const rm = fs.rmSync;
fs.rmSync = function(target, ...args) {
  if (mode === "blocked-after-ack" && typeof target === "string" && target.endsWith("/exit-entry.json")) throw new Error("fixture marker reset failure");
  return Reflect.apply(rm, this, [target, ...args]);
};
const schedule = globalThis.setTimeout;
const cancel = globalThis.clearTimeout;
const deadlines = new Map();
const diagnosticTimers = new Map();
let diagnosticsInvoked = false;
const diagnosticDeadline = { delay: 0, scheduled: 0, fired: 0 };
const recordDiagnosticDeadline = () => fs.writeFileSync(${JSON.stringify(diagnosticReceipt)}, JSON.stringify(diagnosticDeadline));
globalThis.setTimeout = (callback, delay, ...args) => {
  if (diagnosticsInvoked && delay === 2000) {
    diagnosticDeadline.delay = delay;
    diagnosticDeadline.scheduled++;
    recordDiagnosticDeadline();
    return schedule(() => {
      diagnosticDeadline.fired++;
      recordDiagnosticDeadline();
      callback(...args);
    }, delay);
  }
  if (delay === 10000) {
    const timer = schedule(() => { diagnosticTimers.delete(timer); callback(...args); }, delay);
    diagnosticTimers.set(timer, () => callback(...args));
    return timer;
  }
  if (delay !== 60000) return schedule(callback, delay, ...args);
  const invoke = () => callback(...args);
  const timer = schedule(() => { deadlines.delete(timer); invoke(); }, delay);
  deadlines.set(timer, invoke);
  return timer;
};
globalThis.clearTimeout = timer => { deadlines.delete(timer); diagnosticTimers.delete(timer); return cancel(timer); };
const finishStop = () => {
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ liveDeadlines: deadlines.size, delay: 60000 }));
  if (deadlines.size !== 1) throw new Error("expected one live Vitest stop deadline");
  const [timer, invoke] = deadlines.entries().next().value;
  cancel(timer);
  deadlines.delete(timer);
  invoke();
};
const stderrWrite = process.stderr.write;
let ownsFork = false;
process.stderr.write = function(chunk, ...args) {
  const result = stderrWrite.call(this, chunk, ...args);
  if (ownsFork && String(chunk).includes("[/vitest-pool-resources]")) setImmediate(finishStop);
  return result;
};
const isFork = arg => typeof arg === "string" && arg.replaceAll("\\\\", "/").endsWith("/vitest/dist/workers/forks.js");
if (isFork(process.argv[1]) && process.send) {
  const send = process.send;
  const held = () => send.call(process, { fixtureTeardownHeld: true }, () => {
    if (mode === "blocked-after-ack") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  if (mode === "missing-ack") {
    const emit = process.emit;
    process.emit = function(event, message, ...args) {
      if (event === "message" && message?.__vitest_worker_request__ === true && message.type === "stop") {
        held();
        return true;
      }
      return emit.call(this, event, message, ...args);
    };
  } else if (mode === "exit-listener") {
    process.on("exit", () => {
      held();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  } else if (mode === "after-ack" || mode === "blocked-after-ack") {
    process.send = function(message, ...args) {
      if (message?.__vitest_worker_response__ === true && message.type === "stopped" && message.willExit === true) {
        // Hold the transport's explicit process.exit callback after its acknowledgement flushes.
        args[args.length - 1] = error => { if (error) throw error; held(); };
      }
      return send.call(this, message, ...args);
    };
  }
}
subscribe("child_process", ({ process: child }) => {
  let selected = false;
  let hasDiagnostic = false;
  child.once("spawn", () => {
    selected = child.spawnargs.some(isFork);
    ownsFork ||= selected;
    hasDiagnostic = child.spawnargs.some(arg => String(arg).endsWith("/vitest.fork-diagnostics.mjs"));
  });
  child.on("message", message => {
    if (!selected || message?.fixtureTeardownHeld !== true) return;
    setImmediate(() => {
      diagnosticsInvoked = true;
      for (const [timer, invoke] of diagnosticTimers) {
        cancel(timer);
        invoke();
      }
      diagnosticTimers.clear();
      if (!hasDiagnostic) finishStop();
    });
  });
});
`,
      );
      const workerReceipts = path.join(root, "workers.jsonl");
      const exitReceipt = path.join(root, "exit.json");
      for (const filename of ["first.test.ts", "second.test.ts"]) {
        fs.writeFileSync(
          path.join(root, filename),
          `
import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { Worker, isMainThread } from "node:worker_threads";
import { expect, it } from "vitest";
it("runs on the fork main thread with ready native handles", async () => {
  expect(isMainThread).toBe(true);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const worker = new Worker("require('node:worker_threads').parentPort.postMessage('ready'); setInterval(() => {}, 1000)", { eval: true });
  await once(worker, "message");
  fs.appendFileSync(${JSON.stringify(workerReceipts)}, JSON.stringify({ pid: process.pid, reportDirectory: process.report.directory }) + "\\n");
  if (${JSON.stringify(mode === "after-ack" || mode === "blocked-after-ack")} && process.report.directory) {
    fs.writeFileSync(process.report.directory + "/exit-entry.json", JSON.stringify({ operation: "process.exit", pid: process.pid, enteredAt: 0 }));
  }
  if (${JSON.stringify(mode === "normal" || mode === "write-failure")}) {
    if (${JSON.stringify(filename)} === "first.test.ts") {
      const exitPath = process.report.directory && process.report.directory + "/exit-entry.json";
      if (${JSON.stringify(mode)} === "write-failure" && exitPath) fs.mkdirSync(exitPath);
      process.on("exit", code => {
        const marker = exitPath && ${JSON.stringify(mode)} === "normal" ? JSON.parse(fs.readFileSync(exitPath, "utf8")) : null;
        fs.writeFileSync(${JSON.stringify(exitReceipt)}, JSON.stringify({ code, marker, writeFailure: Boolean(exitPath && fs.statSync(exitPath).isDirectory()) }));
      });
    }
    await worker.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
`,
        );
      }
      const config = path.join(root, "vitest.config.ts");
      const outcomeFile = path.join(root, "outcome.json");
      const outcomes: unknown[] = [];
      for (const useAdapter of [false, true]) {
        fs.writeFileSync(workerReceipts, "");
        for (const file of [receipt, diagnosticReceipt, outcomeFile, exitReceipt]) {
          fs.rmSync(file, { force: true });
        }
        fs.writeFileSync(
          config,
          `
import fs from "node:fs";
import { createInfraVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.infra.config.ts"))};
const infra = createInfraVitestConfig({});
export default {
  root: ${JSON.stringify(root)},
  test: {
    pool: ${useAdapter ? "infra.test.pool" : '"forks"'},
    include: ["*.test.ts"],
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    fsModuleCache: false,
    reporters: ["default", {
      onTestRunEnd(modules, errors, reason) {
        fs.writeFileSync(${JSON.stringify(outcomeFile)}, JSON.stringify({
          reason,
          errors: errors.map(error => error.message),
        }));
      },
    }],
  },
};
`,
        );
        const result = await runVitestShutdownCommand({
          args: [
            path.join(repoRoot, "scripts/run-vitest.mjs"),
            "run",
            "--config",
            config,
            "--root",
            root,
            "--configLoader",
            "native",
          ],
          cwd: root,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            TMPDIR: tmp,
            TMP: tmp,
            TEMP: tmp,
            CI: "1",
            NODE_OPTIONS: `--require=${preload}`,
            OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "cache"),
            POOL_DIAGNOSTIC_FIXTURE_SECRET: "fixture-env-value-do-not-print",
          },
          signal,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toMatch(/2 passed/u);
        const outcome = JSON.parse(fs.readFileSync(outcomeFile, "utf8"));
        expect(outcome, output).toEqual({
          // Vitest's reason reflects test assertions; unhandled teardown errors set the CLI exit.
          reason: "passed",
          errors: mode === "normal" || mode === "write-failure" ? [] : [teardownTimeoutError],
        });
        outcomes.push({ code: result.code, outcome });
        const workers = fs
          .readFileSync(workerReceipts, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; reportDirectory: string });
        expect(new Set(workers.map(({ pid }) => pid)).size).toBe(1);
        const worker = workers[0];
        if (!worker) {
          throw new Error("Expected a recorded worker");
        }
        for (const { reportDirectory } of workers) {
          if (reportDirectory) {
            expect(fs.existsSync(reportDirectory)).toBe(false);
          }
        }
        if (mode === "normal" || mode === "write-failure") {
          expect(JSON.parse(fs.readFileSync(exitReceipt, "utf8"))).toEqual({
            code: 0,
            marker:
              useAdapter && mode === "normal"
                ? { operation: "process.exit", pid: worker.pid, enteredAt: expect.any(Number) }
                : null,
            writeFailure: useAdapter && mode === "write-failure",
          });
          expect(result.code, output).toBe(0);
          expect(output).not.toContain("vitest-pool-diagnostics");
          expect(output).not.toContain("Writing Node.js report");
          continue;
        }
        expect(result.code, output).toBe(1);
        expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toEqual({
          liveDeadlines: 1,
          delay: 60_000,
        });
        expect(output).toContain(teardownTimeoutError);
        if (!useAdapter) {
          expect(output).not.toContain("vitest-pool-diagnostics");
          continue;
        }
        const report = output.match(
          /\[vitest-pool-diagnostics\][^\n]*\n([\s\S]*?)\n\[\/vitest-pool-diagnostics\]/u,
        )?.[1];
        expect(report, output).toBeDefined();
        expect(output).toContain(`stopAcknowledged=${mode !== "missing-ack"}`);
        expect(output).not.toMatch(
          /fixture-env-value-do-not-print|127\.0\.0\.1|localEndpoint|remoteEndpoint/u,
        );
        if (mode === "exit-listener") {
          const marker = output.match(/exit-entry\.json: (\{[^\n]+\})/u)?.[1];
          expect(marker, output).toBeDefined();
          expect(JSON.parse(marker!)).toEqual({
            operation: "process.exit",
            pid: worker.pid,
            enteredAt: expect.any(Number),
          });
          expect(report).toBe("No complete Node diagnostic report captured within 2000ms.");
          continue;
        }
        expect(output.match(/exit-entry\.json: ([^\n]+)/u)?.[1]).toBe(
          mode === "blocked-after-ack" ? "unavailable (stop reset failed)" : "unavailable",
        );
        if (mode === "blocked-after-ack") {
          expect(report).toBe("No complete Node diagnostic report captured within 2000ms.");
          expect(output).toContain('"operation":"Atomics.wait"');
          expect(JSON.parse(fs.readFileSync(diagnosticReceipt, "utf8"))).toEqual({
            delay: 2_000,
            scheduled: 1,
            fired: 1,
          });
          continue;
        }
        expect(output).toContain('"resources":');
        expect(output).toContain('"handles":');
        expect(output).toContain('"workers":[{"threadId":');
        expect(JSON.parse(report!)).toMatchObject({
          nativeStack: expect.any(Array),
          libuv: expect.arrayContaining([
            expect.objectContaining({ type: "tcp", is_active: true, is_referenced: true }),
          ]),
          workers: expect.arrayContaining([
            expect.objectContaining({
              threadId: expect.any(Number),
              libuv: expect.arrayContaining([expect.objectContaining({ type: "timer" })]),
            }),
          ]),
        });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
    }),
);

posixNodeIt(
  "preserves real exit arguments, errors, and listeners with the exit marker",
  ({ signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const root = fixture.createTempDir("openclaw-exit-entry-");
      const outcomes = [];
      for (const useAdapter of [false, true]) {
        const reports = path.join(root, useAdapter ? "adapter" : "native");
        fs.mkdirSync(reports);
        const receipt = path.join(reports, "listener.json");
        const stderr = createBoundedChildOutput();
        const code = await runManagedCommand({
          bin: process.execPath,
          args: [
            `--report-directory=${reports}`,
            ...(useAdapter
              ? ["--import", path.join(repoRoot, "test/vitest/vitest.fork-diagnostics.mjs")]
              : []),
            "--input-type=module",
            "--eval",
            `
import assert from "node:assert/strict";
import fs from "node:fs";
const markerPath = ${JSON.stringify(path.join(reports, "exit-entry.json"))};
const before = process.exitCode;
assert.throws(() => Reflect.apply(process.exit, process, [{}]), { code: "ERR_INVALID_ARG_TYPE" });
assert.equal(process.exitCode, before);
if (${useAdapter}) {
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.deepEqual(Object.keys(marker).sort(), ["enteredAt", "operation", "pid"]);
  assert.equal(marker.operation, "process.exit");
  assert.equal(marker.pid, process.pid);
  assert.equal(typeof marker.enteredAt, "number");
  fs.unlinkSync(markerPath);
}
process.on("exit", code => {
  const marker = ${useAdapter} ? JSON.parse(fs.readFileSync(markerPath, "utf8")) : null;
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ code, marker, pid: process.pid }));
});
process.exit("7");
`,
          ],
          cwd: root,
          env: { ...process.env, HOME: root, USERPROFILE: root },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          requireProcessTreeExit: true,
          onReady(child) {
            child.stderr?.on("data", stderr.append);
          },
          signal,
        });
        expect(code, stderr.text()).toBe(7);
        const result = JSON.parse(fs.readFileSync(receipt, "utf8"));
        expect(result).toEqual({
          code: 7,
          pid: expect.any(Number),
          marker: useAdapter
            ? { operation: "process.exit", pid: result.pid, enteredAt: expect.any(Number) }
            : null,
        });
        outcomes.push({ code, listenerCode: result.code });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
    }),
);

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import {
  readInstalledTerminalDependencyTree,
  readInstalledTerminalMetadata,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-contracts.mjs";
import {
  assertInstalledTerminalOutput,
  buildInstalledTerminalSummary,
  captureInstalledTerminalProcessAbsence,
  installedTerminalDescendants,
  type InstalledTerminalProcessAbsence,
  publishInstalledTerminalEvidence,
  readInstalledTerminalClosedEntries,
  readInstalledTerminalEvents,
  readInstalledTerminalHasher,
  readInstalledTerminalHeartbeat,
  restoreInstalledTerminalLauncher,
  summarizeInstalledTerminalLaunches,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-observer.mjs";
import { readWorkerCellPackageIdentity } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { execNodeEvalSync, resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJsonLines, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const observer = path.resolve("scripts/e2e/lib/upgrade-survivor/installed-terminal-observer.mjs");

function captureNodeProcessAbsence(directory: string): InstalledTerminalProcessAbsence[] {
  const receipts: InstalledTerminalProcessAbsence[] = JSON.parse(
    execNodeEvalSync(
      `import {captureInstalledTerminalProcessAbsence} from ${JSON.stringify(observer)};
       process.stdout.write(JSON.stringify(captureInstalledTerminalProcessAbsence(${JSON.stringify(directory)})));`,
      {
        env: { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
        timeout: 10_000,
      },
    ),
  );
  expect(receipts.every((receipt) => receipt.observerPid !== process.pid)).toBe(true);
  return receipts;
}

function terminalOutputFixture() {
  const root = "/fixture/npm/lib/node_modules/openclaw";
  const candidateResult = {
    status: "ok",
    mode: "npm",
    root,
    runId: "terminal-run",
    before: { version: "2026.10.9" },
    after: { version: "2026.10.10-first-hop.1" },
  };
  const candidateStdout = `${JSON.stringify(candidateResult)}\n`;
  const detail =
    "Update backup cleanup failed: Selected package launcher identity changed.. Inspect /fixture/backup/previous before manual cleanup.";
  const step = {
    name: "package-backup-retention",
    command: "openclaw update",
    cwd: root,
    exitCode: 1,
    stderrTail: detail,
  };
  const output = {
    ...candidateResult,
    status: "error",
    reason: "update-recovery-pending",
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    steps: [step],
  };
  const parentOutput = { event: "stdout", pid: 10, thread: 0, time: "50", bytes: "" };
  const fault = { event: "launcher-replaced", pid: 10, thread: 0, time: "40" };
  const rows: Record<string, unknown>[] = [
    { event: "startup", pid: 10, ppid: 1 },
    { event: "spawn", pid: 10, child: 11 },
    { event: "handoff", pid: 10, child: 11, time: "10" },
    { event: "worker-closed", pid: 10, child: 11, time: "20", stdout: candidateStdout },
    {
      event: "candidate-success",
      pid: 10,
      child: 11,
      time: "30",
      response: { terminalRunId: candidateResult.runId },
    },
    fault,
    parentOutput,
  ];
  const result = { pid: 10, code: 1, stdout: "", stderr: `${detail}\n` };
  const publish = (text = `${JSON.stringify(output)}\n`) => {
    result.stdout = text;
    parentOutput.bytes = Buffer.from(text).toString("base64");
  };
  publish();
  return {
    rows,
    output,
    step,
    result,
    fault,
    parentOutput,
    candidateStdout,
    publish,
    spec: { root, fault: true, historical: false },
  };
}

function healthyTerminalOutputFixture() {
  const f = terminalOutputFixture();
  f.spec.fault = false;
  f.result.code = 0;
  f.rows.splice(f.rows.indexOf(f.fault), 1);
  f.publish(f.candidateStdout);
  return f;
}

it("binds healthy publication to the exact settled candidate and parent", () => {
  const f = healthyTerminalOutputFixture();
  assertInstalledTerminalOutput(f.rows, f.spec, f.result);
  f.rows.push({ event: "stdout", pid: 10, thread: 8, time: "1", bytes: "" });
  const bytes = Buffer.from(f.result.stdout);
  f.parentOutput.bytes = bytes.subarray(0, 17).toString("base64");
  f.rows.push({ ...f.parentOutput, time: "51", bytes: bytes.subarray(17).toString("base64") });
  assertInstalledTerminalOutput(f.rows, f.spec, f.result);

  const invalid: [string, (value: ReturnType<typeof healthyTerminalOutputFixture>) => void][] = [
    [
      "exit failure",
      (value) => {
        value.result.code = 1;
      },
    ],
    [
      "changed version",
      (value) => {
        const output = JSON.parse(value.candidateStdout);
        output.after.version = "stale";
        value.publish(`${JSON.stringify(output)}\n`);
      },
    ],
    [
      "extra bytes",
      (value) => {
        value.publish(`${value.candidateStdout} `);
      },
    ],
    [
      "missing capture",
      (value) => {
        value.parentOutput.bytes = "";
      },
    ],
    [
      "early publication",
      (value) => {
        value.parentOutput.time = "29";
      },
    ],
    [
      "Worker publication",
      (value) => {
        value.parentOutput.thread = 8;
      },
    ],
    [
      "foreign publication",
      (value) => {
        value.rows.push({ event: "spawn", pid: 10, child: 12 });
        value.rows.push({
          ...value.parentOutput,
          pid: 12,
          bytes: Buffer.from("extra").toString("base64"),
        });
      },
    ],
    [
      "closure after success",
      (value) => {
        const closed = value.rows.find((row) => row.event === "worker-closed");
        assert(closed);
        closed.time = "31";
      },
    ],
    [
      "wrong candidate child",
      (value) => {
        const success = value.rows.find((row) => row.event === "candidate-success");
        assert(success);
        success.child = 12;
      },
    ],
  ];
  for (const time of ["10", "11", "29", "30", "31"]) {
    invalid.push([
      `foreign writer at terminal time ${time}`,
      (value) => {
        value.rows.push({ event: "spawn", pid: 10, child: 12 });
        value.rows.push({ ...value.parentOutput, pid: 12, time });
      },
    ]);
  }
  for (const key of ["root", "runId"] as const) {
    invalid.push([
      `stale candidate ${key}`,
      (value) => {
        const closed = value.rows.find((row) => row.event === "worker-closed");
        assert(closed);
        const output = JSON.parse(value.candidateStdout);
        output[key] = "stale";
        closed.stdout = `${JSON.stringify(output)}\n`;
        value.publish(String(closed.stdout));
      },
    ]);
  }
  for (const [label, mutate] of invalid) {
    const value = healthyTerminalOutputFixture();
    mutate(value);
    expect(
      () => assertInstalledTerminalOutput(value.rows, value.spec, value.result),
      label,
    ).toThrow();
  }
});

it("separates captured inspection replies from inherited or forwarded CLI bytes", () => {
  for (const mode of ["captured", "inherited", "forwarded"]) {
    const observed = fixture();
    const f = healthyTerminalOutputFixture();
    const parent = path.join(observed.root, "capture.mjs");
    const child = path.join(observed.root, "reply.cjs");
    const reply = '{"ok":true,"ownershipJson":"null"}';
    fs.writeFileSync(child, `process.stdout.write(${JSON.stringify(reply)});`);
    fs.writeFileSync(
      parent,
      `import assert from 'node:assert/strict';
       import { execFile, spawn } from 'node:child_process';
       import { once } from 'node:events';
       let captured;
       const child = ${JSON.stringify(mode)} === 'inherited'
         ? spawn(process.execPath, [${JSON.stringify(child)}], {stdio:['ignore','inherit','pipe']})
         : execFile(process.execPath, [${JSON.stringify(child)}], {encoding:'utf8'}, (error, stdout) => {
             assert.ifError(error);
             captured = stdout;
           });
       const [code, signal] = await once(child, 'close');
       assert.equal(code, 0);
       assert.equal(signal, null);
       if (${JSON.stringify(mode)} !== 'inherited') assert.equal(captured, ${JSON.stringify(reply)});
       if (${JSON.stringify(mode)} === 'forwarded') process.stdout.write(captured);
       process.stdout.write(${JSON.stringify(f.candidateStdout)});`,
    );
    const plain = runProcess(node, [parent], process.env, 10_000);
    const result = runProcess(node, [parent], observed.env, 10_000);
    expect(result.status, result.stderr).toBe(0);
    expect([result.status, result.signal, result.stdout], mode).toEqual([
      plain.status,
      plain.signal,
      plain.stdout,
    ]);
    expect(result.stdout).toBe(`${mode === "captured" ? "" : reply}${f.candidateStdout}`);
    const rows = readInstalledTerminalEvents(observed.spec.directory);
    const startup = rows.find((row) => row.event === "startup" && row.entry === parent);
    const childStartup = rows.find((row) => row.event === "startup" && row.entry === child);
    assert(startup && typeof startup.pid === "number" && childStartup);
    expect(childStartup.ppid).toBe(startup.pid);
    const replies = rows.filter((row) => row.event === "stdout" && row.pid === childStartup.pid);
    expect(replies).toHaveLength(1);
    const recorded = replies[0];
    assert(recorded && typeof recorded.time === "string");
    expect(Buffer.from(String(recorded.bytes), "base64").toString()).toBe(reply);
    // Keep the real stdout records intact. The pure oracle's candidate facts
    // place its terminal window after the captured reply, before parent output.
    const candidatePid = startup.pid + 1_000_000;
    for (const row of f.rows.filter(
      (event) => event.event !== "startup" && event.event !== "stdout",
    )) {
      row.pid = startup.pid;
      row.child = candidatePid;
      if (typeof row.time === "string") {
        row.time = (BigInt(recorded.time) + BigInt(row.time)).toString();
      }
      rows.push(row);
    }
    const output = { ...f.result, pid: startup.pid, stdout: result.stdout };
    if (mode === "captured") {
      assertInstalledTerminalOutput(rows, f.spec, output);
    } else {
      expect(() => assertInstalledTerminalOutput(rows, f.spec, output), mode).toThrow(
        "Healthy stdout changed candidate bytes",
      );
    }
  }
});

it("validates terminal output as one settled parent error without replaying candidate success", () => {
  const f = terminalOutputFixture();
  assertInstalledTerminalOutput(f.rows, f.spec, f.result);
  const bytes = Buffer.from(f.result.stdout);
  f.parentOutput.bytes = bytes.subarray(0, 37).toString("base64");
  f.rows.push({ ...f.parentOutput, time: "51", bytes: bytes.subarray(37).toString("base64") });
  assertInstalledTerminalOutput(f.rows, f.spec, f.result);

  const invalid: [string, (value: ReturnType<typeof terminalOutputFixture>) => void][] = [
    [
      "success envelope",
      (value) => {
        value.output.status = "ok";
      },
    ],
    [
      "wrong reason",
      (value) => {
        value.output.reason = "unrelated-failure";
      },
    ],
    [
      "foreign root",
      (value) => {
        value.output.root = "/other/install";
      },
    ],
    [
      "foreign run",
      (value) => {
        value.output.runId = "other-run";
      },
    ],
    [
      "changed candidate version",
      (value) => {
        value.output.after = { version: "other" };
      },
    ],
    [
      "history projection",
      (value) => {
        Object.assign(value.output, { run: {} });
      },
    ],
    [
      "restart permitted",
      (value) => {
        value.output.recovery.serviceRestartSafe = true;
      },
    ],
    [
      "unrelated step",
      (value) => {
        value.step.name = "database-cleanup";
      },
    ],
    [
      "foreign step root",
      (value) => {
        value.step.cwd = "/other/install";
      },
    ],
    [
      "successful step",
      (value) => {
        value.step.exitCode = 0;
      },
    ],
    [
      "multiple failures",
      (value) => {
        value.output.steps.push({ ...value.step });
      },
    ],
    [
      "wrong refusal",
      (value) => {
        value.step.stderrTail = "Disk full";
      },
    ],
    [
      "missing exact stderr",
      (value) => {
        value.result.stderr = "Selected package launcher identity changed";
      },
    ],
    [
      "exit success",
      (value) => {
        value.result.code = 0;
      },
    ],
    [
      "early output",
      (value) => {
        value.parentOutput.time = "35";
      },
    ],
    [
      "foreign output",
      (value) => {
        value.parentOutput.pid = 11;
      },
    ],
    [
      "worker output",
      (value) => {
        value.parentOutput.thread = 1;
      },
    ],
    [
      "foreign fault",
      (value) => {
        value.fault.pid = 11;
      },
    ],
    [
      "fault before success",
      (value) => {
        value.fault.time = "25";
      },
    ],
  ];
  for (const [name, change] of invalid) {
    const bad = terminalOutputFixture();
    change(bad);
    bad.publish();
    expect(() => assertInstalledTerminalOutput(bad.rows, bad.spec, bad.result), name).toThrow();
  }
  for (const extra of ["progress\n", f.candidateStdout, `${JSON.stringify(f.output)}\n`]) {
    const bad = terminalOutputFixture();
    bad.publish(extra + bad.result.stdout);
    expect(() => assertInstalledTerminalOutput(bad.rows, bad.spec, bad.result)).toThrow();
  }
  const missing = terminalOutputFixture();
  missing.parentOutput.bytes = "";
  expect(() => assertInstalledTerminalOutput(missing.rows, missing.spec, missing.result)).toThrow(
    "Parent stdout capture mismatch",
  );
});

it("keeps healthy terminal output and the historical premature-success control distinct", () => {
  const f = terminalOutputFixture();
  f.spec.fault = false;
  f.result.code = 0;
  f.publish(f.candidateStdout);
  assertInstalledTerminalOutput(f.rows, f.spec, f.result);
  f.result.code = 1;
  expect(() => assertInstalledTerminalOutput(f.rows, f.spec, f.result)).toThrow();
  f.spec.fault = true;
  f.spec.historical = true;
  f.parentOutput.time = "35";
  assertInstalledTerminalOutput(f.rows, f.spec, f.result);
  const stderr = f.result.stderr;
  f.result.stderr = "Selected package launcher identity changed during admission";
  expect(() => assertInstalledTerminalOutput(f.rows, f.spec, f.result)).toThrow(
    "Missing exact package backup cleanup refusal",
  );
  f.result.stderr = stderr;
  f.spec.historical = false;
  expect(() => assertInstalledTerminalOutput(f.rows, f.spec, f.result)).toThrow(
    "Parent republished candidate success",
  );
  f.spec.historical = true;
  f.publish();
  expect(() => assertInstalledTerminalOutput(f.rows, f.spec, f.result)).toThrow(
    "Historical driver did not expose",
  );
  f.parentOutput.bytes = Buffer.from(f.candidateStdout).toString("base64");
  expect(() => assertInstalledTerminalOutput(f.rows, f.spec, f.result)).toThrow(
    "Historical success did not reach CLI stdout",
  );
});

it("distinguishes real empty Worker drains from early terminal output bytes", () => {
  const observed = fixture();
  const script = path.join(observed.root, "empty-output.mjs");
  const worker = path.join(observed.root, "empty-output-worker.cjs");
  fs.writeFileSync(worker, "process.stdout.write('', () => {});");
  // Node's classic eval Worker skips --import; a file entry runs the preload.
  fs.writeFileSync(
    script,
    `import assert from 'node:assert/strict';
     import { once } from 'node:events';
     import { Worker } from 'node:worker_threads';
     const worker = new Worker(${JSON.stringify(worker)});
     const [code] = await once(worker, 'exit');
     assert.equal(code, 0);`,
  );
  const result = runProcess(node, [script], observed.env, 10_000);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  const drain = readInstalledTerminalEvents(observed.spec.directory).find(
    (row) => row.event === "stdout" && row.thread !== 0,
  );
  assert(drain && typeof drain.pid === "number" && typeof drain.time === "string");
  expect(drain.bytes).toBe("");

  const f = terminalOutputFixture();
  // Place the pure oracle's synthetic handoff after the real recorded drain.
  // The native record itself, including its Worker identity/time, stays intact.
  for (const row of f.rows) {
    if (row.pid === f.result.pid) {
      row.pid = drain.pid;
    }
    if (typeof row.time === "string") {
      row.time = (BigInt(drain.time) + BigInt(row.time)).toString();
    }
  }
  f.result.pid = drain.pid;
  f.rows.push(drain);
  assertInstalledTerminalOutput(f.rows, f.spec, f.result);
  f.rows[f.rows.length - 1] = { ...drain, bytes: Buffer.from(" ").toString("base64") };
  f.result.stdout += " ";
  expect(() => assertInstalledTerminalOutput(f.rows, f.spec, f.result)).toThrow(
    "Parent publication preceded the settlement fault",
  );
});

it("reports a final failure for driver and shell preflight rejection without starting Docker", () => {
  const driver = runProcess(
    node,
    [path.resolve("scripts/e2e/lib/upgrade-survivor/installed-terminal.mjs")],
    process.env,
    10_000,
  );
  expect(driver.status).toBe(1);
  expect(driver.stderr.trimEnd().split("\n").at(-1)).toBe("[installed-terminal] FAILED (exit 1)");
  expect(driver.stderr).toContain("[installed-terminal] terminal-error");
  const shell = runProcess(
    "/bin/bash",
    [path.resolve("scripts/e2e/installed-terminal-docker.sh")],
    { ...process.env, CELL_DEADLINE_EPOCH_SECONDS: "invalid" },
    10_000,
  );
  expect(shell.status).toBe(2);
  expect(shell.stderr.trimEnd().split("\n").at(-1)).toBe("[installed-terminal] FAILED (exit 2)");
  expect(shell.stdout).toBe("");
});

function fixture() {
  const root = fs.realpathSync(dirs.make("installed-terminal-observer-"));
  const directory = path.join(root, "events");
  fs.mkdirSync(directory);
  const spec = {
    directory,
    root,
    bin: path.join(root, "bin/openclaw"),
    journal: path.join(root, "journal.sqlite"),
    stateDatabase: path.join(root, "state.sqlite"),
    agentDatabase: path.join(root, "agent.sqlite"),
    escrow: path.join(root, "escrow"),
    fault: true,
    agentVersion: 39,
  };
  const specPath = path.join(root, "spec.json");
  writeJson(specPath, spec);
  return {
    root,
    spec,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${observer}`,
      OPENCLAW_INSTALLED_TERMINAL_OBSERVER: specPath,
    },
    records: () =>
      fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(".jsonl"))
        .flatMap((name) => readJsonLines<Record<string, unknown>>(path.join(directory, name))),
  };
}

it("preserves SQLite construction, getters, errors and explicit open while covering child isolates", () => {
  const f = fixture();
  const script = path.join(f.root, "transparent.cjs");
  const workerPath = path.join(f.root, "transparent-worker.cjs");
  fs.writeFileSync(
    workerPath,
    "const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close();",
  );
  fs.writeFileSync(
    script,
    `
    const assert = require('node:assert/strict');
    const { DatabaseSync } = require('node:sqlite');
    const { Worker } = require('node:worker_threads');
    const { spawn } = require('node:child_process');
    const { once } = require('node:events');
    (async () => {
      let reads = 0;
      class Derived extends DatabaseSync {}
      const db = new Derived(':memory:', { get open() { reads++; return false; } });
      assert.equal(reads, 1); assert(db instanceof Derived); assert.equal(db.isOpen, false);
      db.open(); assert.equal(db.isOpen, true);
      const error = (fn) => { try { fn(); assert.fail('missing error'); } catch (e) { return [e.name, e.code, e.message]; } };
      const errors = [error(() => db.open()), error(() => DatabaseSync.prototype.open.call({})), error(() => new DatabaseSync(42))];
      db.close();
      const fs = require('node:fs');
      const file = ${JSON.stringify(path.join(f.root, "canonical.sqlite"))};
      const alias = ${JSON.stringify(path.join(f.root, "alias.sqlite"))};
      const created = new DatabaseSync(file); created.close();
      let nativeOptionsRead = false;
      const bufferPath = Buffer.from(file);
      bufferPath.toString = () => { assert(nativeOptionsRead, 'path conversion ran before native options'); return file; };
      const buffered = new DatabaseSync(bufferPath, {get open(){nativeOptionsRead=true; return true;}}); buffered.close();
      fs.symlinkSync(file, alias);
      const deferred = new DatabaseSync(alias, {open:false}); deferred.open(); deferred.close();
      const child = spawn(process.execPath, ['-e', "const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close()"], { stdio: 'ignore' });
      const worker = new Worker(${JSON.stringify(workerPath)}, { execArgv: [] });
      const [[code], [workerCode]] = await Promise.all([once(child, 'close'), once(worker, 'exit')]);
      assert.equal(code, 0); assert.equal(workerCode, 0);
      console.log(JSON.stringify({ reads, errors }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
  );
  const plain = runProcess(
    node,
    [script],
    { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
    10_000,
  );
  fs.unlinkSync(path.join(f.root, "alias.sqlite"));
  const observed = runProcess(node, [script], f.env, 10_000);
  expect(plain.status, plain.stderr).toBe(0);
  expect(observed.status, observed.stderr).toBe(0);
  expect(JSON.parse(observed.stdout)).toEqual(JSON.parse(plain.stdout));
  const rows = f.records();
  expect(rows.filter((row) => row.event === "startup")).toHaveLength(3);
  expect(rows.filter((row) => row.event === "exit")).toHaveLength(3);
  expect(
    rows.filter((row) => row.event === "sqlite-construct" && row.opened === false),
  ).toHaveLength(2);
  expect(rows.filter((row) => row.event === "sqlite-open" && row.opened === true)).toHaveLength(2);
  expect(rows.filter((row) => row.event === "sqlite-construct-error")).toHaveLength(1);
  expect(rows.filter((row) => row.event === "sqlite-open-error")).toHaveLength(2);
  expect(
    rows.find(
      (row) => row.event === "sqlite-open" && row.location === path.join(f.root, "alias.sqlite"),
    ),
  ).toMatchObject({ canonical: path.join(f.root, "canonical.sqlite"), opened: true });
  expect(() => readInstalledTerminalEvents(f.spec.directory)).not.toThrow();
});

it("separates failed spawn attempts without changing native errors or successful custody", () => {
  const f = fixture();
  const script = path.join(f.root, "spawn-attempts.cjs");
  const missing = path.join(f.root, "missing", "node");
  fs.writeFileSync(
    script,
    `
    const assert = require('node:assert/strict');
    const {spawn} = require('node:child_process');
    const attempt = command => new Promise(resolve => {
      const child = spawn(command, ['-e', ''], {stdio:'ignore'});
      assert.equal(child.listenerCount('error'), 0);
      let error;
      child.on('error', value => { error = value; });
      child.once('close', (code, signal) => resolve({pidMissing:child.pid===undefined, error:error?.code, code, signal}));
    });
    (async () => {
      const results = [];
      for (let i=0;i<2;i++) results.push(await attempt(${JSON.stringify(missing)}));
      results.push(...await Promise.all(Array.from({length:3}, () => attempt(${JSON.stringify(missing)}))));
      results.push(await attempt(process.execPath));
      console.log(JSON.stringify(results));
    })().catch(error => { console.error(error); process.exitCode=1; });
  `,
  );
  const plainEnv = { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" };
  const plain = runProcess(node, [script], plainEnv, 10_000);
  const observed = runProcess(node, [script], f.env, 10_000);
  expect(plain.status, plain.stderr).toBe(0);
  expect(observed.status, observed.stderr).toBe(0);
  expect(observed.stdout).toBe(plain.stdout);
  const rows = readInstalledTerminalEvents(f.spec.directory);
  const attempts = rows.filter((row) => row.event === "spawn");
  expect(attempts).toHaveLength(6);
  expect(attempts.filter((row) => row.child === null)).toHaveLength(5);
  expect(new Set(attempts.map((row) => row.spawnId)).size).toBe(6);
  expect(rows.filter((row) => row.event === "spawn-close" && row.spawned === false)).toHaveLength(
    5,
  );
  expect(rows.filter((row) => row.event === "startup")).toHaveLength(2);
  const pid = attempts[0]?.pid;
  assert(typeof pid === "number");
  const log = path.join(f.spec.directory, `${pid}-0.jsonl`);
  const original = fs.readFileSync(log, "utf8");
  const parentRows = readJsonLines<Record<string, unknown>>(log);
  const rewrite = (events: Record<string, unknown>[]) =>
    fs.writeFileSync(
      log,
      events.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
    );
  rewrite(
    parentRows.map((row) =>
      row.event === "spawn-close" && row.child === null ? { ...row, spawned: true } : row,
    ),
  );
  expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow(
    "no qualified native start outcome",
  );
  rewrite(parentRows.filter((row) => !(row.event === "spawn-close" && row.spawnId === 0)));
  expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow('"matches":[]');
  const closed = parentRows.find((row) => row.event === "spawn-close" && row.spawnId === 0);
  assert(closed);
  rewrite([...parentRows, closed]);
  expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("no unique native exit");
  fs.writeFileSync(log, original);
  const unhandled = fixture();
  fs.writeFileSync(script, `require('node:child_process').spawn(${JSON.stringify(missing)});`);
  for (const env of [plainEnv, unhandled.env]) {
    const result = runProcess(node, [script], env, 10_000);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unhandled 'error' event");
    expect(result.stderr).toContain("ENOENT");
  }
});

it.skipIf(process.platform !== "linux").each(["spawnSync", "spawn"])(
  "qualifies only the native Node version operation through %s",
  (api) => {
    const f = fixture();
    const script = path.join(f.root, "native-version.mjs");
    const modes = [
      "valid",
      "inherited",
      "non-enumerable-env",
      "node-options",
      "native-loader",
      "shell",
      "extra",
      "foreign",
      "argv-accessor",
      "argv-proxy",
      "options-accessor",
      "options-proxy",
      "env-accessor",
      "env-proxy",
      "env-rewrite",
      "argv-rewrite",
      "cwd-mutation",
      "argv-constructor",
    ];
    fs.writeFileSync(
      script,
      `
      import childProcess from 'node:child_process';
      import path from 'node:path';
      import {pathToFileURL} from 'node:url';
      const results=[];
      for (const mode of ${JSON.stringify(modes)}) {
        let reads=0, command=process.execPath, argv=['--version'], options={env:{},encoding:'utf8'};
        const track=value=>new Proxy(value,{get(target,key,receiver){reads++;return Reflect.get(target,key,receiver);}});
        if(mode==='inherited') delete options.env;
        if(mode==='non-enumerable-env') Object.defineProperty(options,'env',{value:{},enumerable:false});
        if(mode==='node-options') options.env={NODE_OPTIONS:'--no-warnings'};
        if(mode==='native-loader') options.env={LD_LIBRARY_PATH:${JSON.stringify(f.root)}};
        if(mode==='shell') options.shell=true;
        if(mode==='extra') argv.push('--help');
        if(mode==='foreign') command=path.dirname(command)+'/./'+path.basename(command);
        if(mode==='argv-accessor') Object.defineProperty(argv,0,{get(){reads++;return '--version';}});
        if(mode==='argv-proxy') argv=track(argv);
        if(mode==='options-accessor') Object.defineProperty(options,'env',{get(){reads++;return {};}});
        if(mode==='options-proxy') options=track(options);
        if(mode==='env-accessor') Object.defineProperty(options.env,'UNUSED',{enumerable:true,get(){reads++;return '';}});
        if(mode==='env-proxy') options.env=track(options.env);
        if(mode==='env-rewrite') Object.defineProperty(options,'env',{enumerable:true,configurable:true,get(){reads++;Object.defineProperty(options,'env',{value:{},enumerable:true,configurable:true});return {LD_LIBRARY_PATH:${JSON.stringify(f.root)}};}});
        if(mode==='argv-rewrite') Object.defineProperty(argv,0,{configurable:true,get(){reads++;Object.defineProperty(argv,0,{value:'--version',configurable:true});return '--help';}});
        if(mode==='cwd-mutation') {options.cwd=pathToFileURL(${JSON.stringify(f.root)});Object.defineProperty(options.cwd,'protocol',{get(){reads++;options.env.LD_LIBRARY_PATH=${JSON.stringify(f.root)};return 'file:';}});}
        if(mode==='argv-constructor') Object.defineProperty(argv,'constructor',{get(){reads++;options.env.LD_LIBRARY_PATH=${JSON.stringify(f.root)};return Array;}});
        let code,stdout;
        if(${JSON.stringify(api)}==='spawnSync') {
          const result=childProcess.spawnSync(command,argv,options);code=result.status;stdout=result.stdout;
        } else {
          const child=childProcess.spawn(command,argv,options);stdout='';
          child.stdout.on('data',chunk=>stdout+=chunk);
          code=await new Promise(resolve=>child.once('close',resolve));
        }
        results.push({mode,code,stdout,reads});
      }
      console.log(JSON.stringify(results));
    `,
    );
    const plain = runProcess(
      node,
      [script],
      {
        ...process.env,
        NODE_OPTIONS: "",
        OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "",
      },
      10_000,
    );
    const observed = runProcess(node, [script], f.env, 10_000);
    expect(plain.status, plain.stderr).toBe(0);
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout).toBe(plain.stdout);
    const rows = f.records();
    const launches = rows.filter((row) => row.event === "spawn");
    expect(launches).toHaveLength(modes.length);
    expect(rows.filter((row) => row.event === "startup")).toHaveLength(1);
    const startup = rows.find((row) => row.event === "startup");
    assert(startup && Array.isArray(startup.argv));
    const valid = launches[0];
    assert(valid && typeof valid.pid === "number");
    const parentExit = rows.at(-1);
    assert(parentExit?.event === "exit" && typeof parentExit.time === "string");
    const scope = { time: String(BigInt(parentExit.time) - 1n), child: 999999, databases: [] };
    const handoff = { ...parentExit, event: "handoff", ...scope };
    writeJson(path.join(f.spec.directory, "handoff.json"), scope);
    const log = path.join(f.spec.directory, `${valid.pid}-0.jsonl`);
    const write = (events: Record<string, unknown>[]) =>
      fs.writeFileSync(
        log,
        [...events.slice(0, -1), handoff, events.at(-1)]
          .map((row, sequence) => JSON.stringify({ ...row, sequence }))
          .join("\n") + "\n",
      );
    const select = (created: Record<string, unknown>) =>
      rows.filter((row) => row.spawnId === undefined || row.spawnId === created.spawnId);
    for (const [index, created] of launches.entries()) {
      write(select(created));
      if (index === 0) {
        expect(created.nativeOperation).toMatchObject({
          kind: "node-version",
          executable: startup.argv[0],
        });
        expect(
          readInstalledTerminalEvents(f.spec.directory).find((row) => row.event === "spawn")
            ?.coverage,
        ).toEqual({ role: "node-version", reason: "native-before-js" });
      } else {
        expect(created.nativeOperation, modes[index]).toBeUndefined();
        expect(() => readInstalledTerminalEvents(f.spec.directory), modes[index]).toThrow(
          /Missing Node child preload|argv observation is unqualified/,
        );
      }
    }
    const selected = select(valid);
    const ended = selected.find(
      (row) => row.event === (api === "spawnSync" ? "spawn-sync-return" : "spawn-exit"),
    );
    assert(ended);
    const invalid: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ["missing operation", valid, { nativeOperation: undefined }],
      ["foreign executable", valid, { command: "/foreign/node" }],
      [
        "wrong runtime",
        valid,
        { nativeOperation: Object.assign({}, valid.nativeOperation, { version: "v0.0.0" }) },
      ],
      ["other mode", valid, { argv: ["--help"] }],
      ["nonzero", ended, { code: 1 }],
      ["signal", ended, { code: null, signal: "SIGKILL" }],
      ["spans handoff", ended, { time: scope.time }],
    ];
    for (const [label, target, patch] of invalid) {
      write(selected.map((row) => (row === target ? Object.assign({}, row, patch) : row)));
      expect(() => readInstalledTerminalEvents(f.spec.directory), label).toThrow();
    }
    write([...selected.slice(0, -1), valid, parentExit]);
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow();
    write(selected.filter((row) => row !== ended));
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("no unique native exit");
  },
);

it("records synchronous SQLite children through their exact native return", () => {
  const f = fixture();
  const leaf = path.join(f.root, "sync-leaf.cjs");
  const child = path.join(f.root, "sync-child.cjs");
  const script = path.join(f.root, "sync-parent.cjs");
  fs.writeFileSync(
    leaf,
    "const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close(); console.log('joined');",
  );
  const invoke = (file: string) => `
    const result = Reflect.apply(require('node:child_process').spawnSync, {receiver: true},
      [process.execPath, [${JSON.stringify(file)}], {encoding:'utf8'}]);
    require('node:assert/strict').equal(result.status, 0);
    process.stdout.write(result.stdout);`;
  fs.writeFileSync(child, invoke(leaf));
  fs.writeFileSync(script, invoke(child));
  const plain = runProcess(
    node,
    [script],
    { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
    10_000,
  );
  const observed = runProcess(node, [script], f.env, 10_000);
  expect(plain.status, plain.stderr).toBe(0);
  expect(observed.status, observed.stderr).toBe(0);
  expect(observed.stdout).toBe(plain.stdout);
  const rows = readInstalledTerminalEvents(f.spec.directory);
  expect(rows.filter((row) => row.event === "startup")).toHaveLength(3);
  expect(rows.filter((row) => row.event === "spawn" && row.api === "spawnSync")).toHaveLength(2);
  expect(rows.filter((row) => row.event === "spawn-sync-return")).toHaveLength(2);
  expect(
    rows.filter((row) => ["spawn-exit", "spawn-close"].includes(String(row.event))),
  ).toHaveLength(0);
  expect(rows.filter((row) => row.event === "sqlite-construct")).toEqual([
    expect.objectContaining({ opened: true }),
  ]);
  const created = rows.find(
    (row) => row.event === "spawn" && Array.isArray(row.argv) && row.argv[0] === child,
  );
  assert(created && typeof created.pid === "number" && typeof created.child === "number");
  const parentLog = path.join(f.spec.directory, `${created.pid}-0.jsonl`);
  const childLog = path.join(f.spec.directory, `${created.child}-0.jsonl`);
  const parentRows = readJsonLines<Record<string, unknown>>(parentLog);
  const childRows = readJsonLines<Record<string, unknown>>(childLog);
  const returned = parentRows.find((row) => row.event === "spawn-sync-return");
  assert(returned && typeof returned.time === "string");
  const rewrite = (file: string, events: Record<string, unknown>[]) =>
    fs.writeFileSync(
      file,
      events.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
    );
  for (const invalid of [
    parentRows.filter((row) => row !== returned),
    [...parentRows, returned],
    [...parentRows, created],
    parentRows.map((row) => (row === returned ? Object.assign({}, row, { child: -1 }) : row)),
    parentRows.map((row) =>
      row === returned ? Object.assign({}, row, { time: created.time }) : row,
    ),
    parentRows.map((row) =>
      row === returned
        ? Object.assign({}, row, { code: null, signal: null, errorCode: "EIO" })
        : row,
    ),
  ]) {
    rewrite(parentLog, invalid);
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow();
  }
  rewrite(parentLog, parentRows);
  for (const invalid of [
    childRows.filter((row) => row.event !== "startup"),
    childRows.map((row) => (row.event === "startup" ? Object.assign({}, row, { ppid: -1 }) : row)),
    childRows.map((row) => Object.assign({}, row, { time: returned.time })),
    childRows.filter((row) => row.event !== "spawn-sync-return"),
  ]) {
    rewrite(childLog, invalid);
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow();
  }
  rewrite(childLog, childRows);
  expect(() => readInstalledTerminalEvents(f.spec.directory)).not.toThrow();
  const leafStart = rows.find((row) => row.event === "startup" && row.entry === leaf);
  assert(leafStart && typeof leafStart.pid === "number");
  const leafLog = path.join(f.spec.directory, `${leafStart.pid}-0.jsonl`);
  const leafRows = readJsonLines<Record<string, unknown>>(leafLog);
  rewrite(
    leafLog,
    leafRows.filter((row) => row.event !== "sqlite-construct"),
  );
  expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("observation interrupted");
  rewrite(leafLog, leafRows);
});

it.skipIf(process.platform !== "linux")(
  "preserves synchronous native failure and signal outcomes",
  () => {
    const f = fixture();
    const script = path.join(f.root, "sync-outcomes.cjs");
    fs.writeFileSync(
      script,
      `
    const {spawnSync} = require('node:child_process');
    const results = [
      spawnSync(process.execPath, ['-e', "process.stdout.write('ok')"]),
      spawnSync(process.execPath, ['-e', 'process.exit(7)']),
      spawnSync(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"]),
      spawnSync('/bin/sleep', ['1'], {timeout:25, killSignal:'SIGKILL'}),
      spawnSync(${JSON.stringify(path.join(f.root, "missing-node"))}, [])
    ];
    console.log(JSON.stringify(results.map(r => ({started:r.pid>0, code:r.status,
      signal:r.signal, error:r.error?.code??null, output:r.stdout?.toString()??null,
      buffer:r.stdout===null || Buffer.isBuffer(r.stdout)}))));`,
    );
    const plain = runProcess(
      node,
      [script],
      {
        ...process.env,
        NODE_OPTIONS: "",
        OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "",
      },
      10_000,
    );
    const observed = runProcess(node, [script], f.env, 10_000);
    expect(plain.status, plain.stderr).toBe(0);
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout).toBe(plain.stdout);
    const rows = readInstalledTerminalEvents(f.spec.directory);
    expect(rows.filter((row) => row.event === "spawn-sync-return")).toMatchObject([
      { spawned: true, code: 0, signal: null, errorCode: null },
      { spawned: true, code: 7, signal: null, errorCode: null },
      { spawned: true, code: null, signal: "SIGKILL", errorCode: null },
      { spawned: true, code: null, signal: "SIGKILL", errorCode: "ETIMEDOUT" },
      { spawned: false, child: null, code: null, signal: null, errorCode: "ENOENT" },
    ]);
    if (process.versions.bun) {
      expect(() => captureInstalledTerminalProcessAbsence(f.spec.directory)).toThrow(
        "Kernel absence capture requires the Node monotonic clock",
      );
    }
    expect(captureNodeProcessAbsence(f.spec.directory)).toEqual([]);
  },
);

it("preserves synchronous throws and unsafe metadata without claiming native completion", () => {
  for (const mode of [
    "encoding",
    "getter-throw",
    "max-buffer-array",
    "argv-accessor",
    "argv-proxy",
    "no-preload",
  ]) {
    const f = fixture();
    const script = path.join(f.root, "sync-metadata.cjs");
    const marker = path.join(f.root, "ran");
    fs.writeFileSync(
      script,
      `
      const fs = require('node:fs'), {spawnSync} = require('node:child_process');
      const mode = ${JSON.stringify(mode)}, marker = ${JSON.stringify(marker)};
      let reads=0;
      const sentinel = new Error('native getter');
      const code = "require('node:fs').writeFileSync("+JSON.stringify(marker)+",'ran'); process.stdout.write('ok')";
      let args=['-e',code], options={encoding:mode==='encoding'?'not-an-encoding':'utf8'};
      if(mode==='getter-throw') options={get encoding(){throw sentinel;}};
      if(mode==='max-buffer-array') options.maxBuffer=[1024,1024];
      if(mode==='no-preload') options.env={};
      if(mode==='argv-accessor') Object.defineProperty(args,1,{get(){reads++;return code;}});
      if(mode==='argv-proxy') args=new Proxy(args,{get(target,key,receiver){reads++;return Reflect.get(target,key,receiver);}});
      let outcome;
      try { const result=spawnSync(process.execPath,args,options); outcome={code:result.status,stdout:result.stdout}; }
      catch(error) {outcome={name:error.name,code:error.code,sentinel:error===sentinel};}
      console.log(JSON.stringify({outcome,reads,ran:fs.existsSync(marker)}));`,
    );
    const plain = runProcess(
      node,
      [script],
      {
        ...process.env,
        NODE_OPTIONS: "",
        OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "",
      },
      10_000,
    );
    if (fs.existsSync(marker)) {
      fs.unlinkSync(marker);
    }
    const observed = runProcess(node, [script], f.env, 10_000);
    expect(plain.status, plain.stderr).toBe(0);
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout, mode).toBe(plain.stdout);
    const threw = ["encoding", "getter-throw", "max-buffer-array"].includes(mode);
    if (threw) {
      expect(
        f.records().some((row) => row.event === "spawn-sync-return"),
        mode,
      ).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(f.spec.directory, "observer-failed.json"), "utf8")),
      ).toMatchObject({
        event: "spawn-sync",
        error: "Synchronous spawn threw; native completion is unknown",
      });
      expect(JSON.parse(observed.stdout).ran).toBe(mode === "encoding");
      if (mode === "max-buffer-array") {
        expect(JSON.parse(observed.stdout).outcome).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
      }
    }
    expect(() => readInstalledTerminalEvents(f.spec.directory), mode).toThrow(
      threw
        ? "Observer recording failed"
        : mode === "no-preload"
          ? "Missing Node child preload coverage"
          : "argv observation is unqualified",
    );
  }
});

it.skipIf(process.platform === "win32")(
  "attributes observed Node descendants through a native shell",
  () => {
    const f = fixture();
    const script = path.join(f.root, "shell-parent.cjs");
    const childScript = path.join(f.root, "shell-child.cjs");
    const leafScript = path.join(f.root, "shell-leaf.cjs");
    fs.writeFileSync(
      leafScript,
      "const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close(); console.log('joined');",
    );
    fs.writeFileSync(
      childScript,
      `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(leafScript)}], {stdio:'inherit'});
    child.once('close', code => { process.exitCode = code; });
  `,
    );
    fs.writeFileSync(
      script,
      `
    const {spawn} = require('node:child_process');
    // The trailing command keeps the shell alive instead of exec-replacing it.
    const child = spawn('/bin/sh', ['-c', '"$1" "$2"; code=$?; exit "$code"', 'fixture', process.execPath, ${JSON.stringify(childScript)}], {stdio:'inherit'});
    child.once('close', code => { process.exitCode = code; });
  `,
    );
    const plain = runProcess(
      node,
      [script],
      { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
      10_000,
    );
    const observed = runProcess(node, [script], f.env, 10_000);
    expect(plain.status, plain.stderr).toBe(0);
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout).toBe(plain.stdout);
    const rows = readInstalledTerminalEvents(f.spec.directory);
    const bridge = rows.find((row) => row.event === "spawn" && row.command === "/bin/sh");
    assert(bridge && typeof bridge.pid === "number" && typeof bridge.child === "number");
    const starts = rows.filter((row) => row.event === "startup");
    expect(starts).toHaveLength(3);
    expect(starts.some((row) => row.pid === bridge.child)).toBe(false);
    expect(starts.some((row) => row.ppid === bridge.child)).toBe(true);
    expect(rows.some((row) => row.event === "sqlite-construct")).toBe(true);
    const all = installedTerminalDescendants(rows, bridge.pid);
    expect(starts.every((row) => typeof row.pid === "number" && all.has(row.pid))).toBe(true);
    const subtree = installedTerminalDescendants(rows, bridge.child);
    expect(subtree.size).toBe(3);
    expect(subtree.has(bridge.pid)).toBe(false);
    for (const incomplete of [
      rows.filter((row) => row !== bridge),
      rows.map((row) => (row === bridge ? Object.assign({}, row, { pid: process.pid }) : row)),
    ]) {
      const disconnected = installedTerminalDescendants(incomplete, bridge.pid);
      expect(
        starts.filter((row) => typeof row.pid === "number" && !disconnected.has(row.pid)),
      ).toHaveLength(2);
    }
    const log = path.join(f.spec.directory, `${bridge.pid}-0.jsonl`);
    const parentRows = readJsonLines<Record<string, unknown>>(log);
    fs.writeFileSync(
      log,
      parentRows
        .filter((row) => row.event !== "spawn-exit")
        .map((row, sequence) => JSON.stringify({ ...row, sequence }))
        .join("\n") + "\n",
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("no unique native exit");
  },
);

it("requires parent-native process exit when IPC disconnect suppresses aggregate close", () => {
  const f = fixture();
  const script = path.join(f.root, "ipc-parent.cjs");
  const childScript = path.join(f.root, "ipc-child.cjs");
  fs.writeFileSync(childScript, "process.on('disconnect', () => {}); process.send('ready');");
  fs.writeFileSync(
    script,
    `
    const assert = require('node:assert/strict');
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(childScript)}], {stdio:['ignore','ignore','pipe','ipc']});
    assert.equal(child.listenerCount('error'), 0);
    let aggregateClose = 0;
    child.once('close', () => aggregateClose++);
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    const disconnected = new Promise(resolve => child.once('disconnect', resolve));
    const pipeClosed = new Promise(resolve => child.stderr.once('close', resolve));
    child.once('message', () => child.disconnect());
    Promise.all([exited, disconnected, pipeClosed]).then(([exit]) => {
      setImmediate(() => console.log(JSON.stringify({exit, aggregateClose})));
    });
  `,
  );
  const plain = runProcess(
    node,
    [script],
    { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
    10_000,
  );
  const observed = runProcess(node, [script], f.env, 10_000);
  expect(plain.status, plain.stderr).toBe(0);
  expect(observed.status, observed.stderr).toBe(0);
  expect(observed.stdout).toBe(plain.stdout);
  expect(JSON.parse(observed.stdout)).toEqual({
    exit: { code: 0, signal: null },
    aggregateClose: 0,
  });
  const rows = readInstalledTerminalEvents(f.spec.directory);
  const created = rows.find((row) => row.event === "spawn");
  assert(created && typeof created.pid === "number");
  const nativeExit = rows.find((row) => row.event === "spawn-exit");
  assert(nativeExit);
  expect(nativeExit).toMatchObject({ spawnId: created.spawnId, child: created.child, code: 0 });
  expect(rows.some((row) => row.event === "spawn-close")).toBe(false);
  const log = path.join(f.spec.directory, `${created.pid}-0.jsonl`);
  const parentRows = readJsonLines<Record<string, unknown>>(log);
  const parentExit = parentRows.find((row) => row.event === "exit");
  assert(parentExit && typeof parentExit.time === "string");
  const afterParentExit = String(BigInt(parentExit.time) + 1n);
  for (const invalid of [
    parentRows.filter((row) => row.event !== "spawn-exit"),
    [...parentRows, nativeExit],
    parentRows.map((row) =>
      row.event === "spawn-exit" ? Object.assign({}, row, { time: afterParentExit }) : row,
    ),
  ]) {
    fs.writeFileSync(
      log,
      invalid.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow(
      /native exit|parent custody/,
    );
  }
  if (process.platform !== "linux") {
    return;
  }
  // The real child was reaped above. Model its creator losing the callback,
  // then capture a later kernel fact without pretending the old exit survived.
  const withoutExit = parentRows.filter((row) => row.event !== "spawn-exit");
  const writeParent = (events: Record<string, unknown>[]) =>
    fs.writeFileSync(
      log,
      events.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
    );
  writeParent(withoutExit);
  const processAbsence = captureNodeProcessAbsence(f.spec.directory);
  expect(processAbsence).toHaveLength(1);
  const receipt = processAbsence[0];
  assert(receipt);
  expect(receipt).toMatchObject({
    child: created.child,
    errorCode: "ESRCH",
    ownExitCode: null,
    sourceKind: "linux-pid-absence",
  });
  const admitted = readInstalledTerminalEvents(f.spec.directory, { processAbsence });
  expect(admitted.find((row) => row.event === "spawn")?.lifetimeBound).toEqual(receipt);
  expect(admitted.some((row) => row.event === "spawn-exit")).toBe(false);
  for (const invalid of [
    [receipt, receipt],
    [{ ...receipt, errorCode: null }],
    [{ ...receipt, errorCode: "EPERM" }],
    [{ ...receipt, errorCode: "UNKNOWN" }],
    [{ ...receipt, child: process.pid }],
    [{ ...receipt, time: "1" }],
  ]) {
    expect(() =>
      readInstalledTerminalEvents(f.spec.directory, { processAbsence: invalid }),
    ).toThrow();
  }
  writeParent(
    withoutExit.map((row) =>
      row.event === "spawn" ? Object.assign({}, row, { child: process.pid }) : row,
    ),
  );
  expect(captureNodeProcessAbsence(f.spec.directory)[0]?.errorCode).toBe(null);
  writeParent(withoutExit);
  const childLog = path.join(f.spec.directory, `${receipt.child}-0.jsonl`);
  const childRows = readJsonLines<Record<string, unknown>>(childLog);
  const lastChildRow = childRows.at(-1);
  assert(lastChildRow);
  for (const invalid of [
    childRows.slice(1),
    [
      ...childRows.slice(0, -1),
      { ...lastChildRow, event: "spawn", spawnId: 99, child: 999999, nodeChild: true },
      lastChildRow,
    ],
  ]) {
    fs.writeFileSync(
      childLog,
      invalid.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory, { processAbsence })).toThrow();
  }
  fs.writeFileSync(
    childLog,
    [
      ...childRows.slice(0, -1),
      { ...lastChildRow, event: "sqlite-intent", operation: 0 },
      lastChildRow,
    ]
      .map((row, sequence) => JSON.stringify({ ...row, sequence }))
      .join("\n") + "\n",
  );
  expect(() => readInstalledTerminalEvents(f.spec.directory, { processAbsence })).toThrow(
    "observation interrupted",
  );
});

it.skipIf(process.platform === "win32")(
  "settles a killed main isolate only through its exact direct native exit",
  () => {
    const f = fixture();
    const script = path.join(f.root, "killed-parent.cjs");
    const childScript = path.join(f.root, "killed-child.cjs");
    fs.writeFileSync(
      childScript,
      `const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close();
       process.on('message', () => {}); process.send('ready');`,
    );
    fs.writeFileSync(
      script,
      `const {spawn} = require('node:child_process');
       const child = spawn(process.execPath, [${JSON.stringify(childScript)}], {stdio:['ignore','ignore','inherit','ipc']});
       child.once('message', () => child.kill('SIGKILL'));
       child.once('close', (code, signal) => console.log(JSON.stringify({code, signal})));`,
    );
    const plain = runProcess(
      node,
      [script],
      { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
      10_000,
    );
    const observed = runProcess(node, [script], f.env, 10_000);
    expect(plain.status, plain.stderr).toBe(0);
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout).toBe(plain.stdout);
    expect(JSON.parse(observed.stdout)).toEqual({ code: null, signal: "SIGKILL" });
    const rows = readInstalledTerminalEvents(f.spec.directory);
    const created = rows.find((row) => row.event === "spawn");
    const nativeExit = rows.find((row) => row.event === "spawn-exit");
    assert(created && nativeExit && typeof nativeExit.time === "string");
    assert(typeof created.pid === "number" && typeof created.child === "number");
    expect(nativeExit).toMatchObject({
      child: created.child,
      spawned: true,
      code: null,
      signal: "SIGKILL",
    });
    const parentLog = path.join(f.spec.directory, `${created.pid}-0.jsonl`);
    const childLog = path.join(f.spec.directory, `${created.child}-0.jsonl`);
    const parentRows = readJsonLines<Record<string, unknown>>(parentLog);
    const childRows = readJsonLines<Record<string, unknown>>(childLog);
    const started = childRows.find((row) => row.event === "startup");
    assert(started && typeof started.time === "string");
    expect(childRows.some((row) => row.event === "exit")).toBe(false);
    expect(childRows.filter((row) => row.event === "sqlite-construct")).toEqual([
      expect.objectContaining({ opened: true }),
    ]);
    const rewrite = (file: string, events: Record<string, unknown>[]) =>
      fs.writeFileSync(
        file,
        events.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
      );
    for (const invalid of [
      parentRows.filter((row) => row.event !== "spawn-exit"),
      [...parentRows, nativeExit],
      [...parentRows, created],
      parentRows.map((row) =>
        row.event === "spawn-exit" ? Object.assign({}, row, { child: -1 }) : row,
      ),
    ]) {
      rewrite(parentLog, invalid);
      expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow();
    }
    rewrite(parentLog, parentRows);
    for (const invalid of [
      childRows.filter((row) => row.event !== "startup"),
      childRows.map((row) =>
        row.event === "startup" ? Object.assign({}, row, { ppid: -1 }) : row,
      ),
      childRows.map((row) => Object.assign({}, row, { time: nativeExit.time })),
    ]) {
      rewrite(childLog, invalid);
      expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow();
    }
    // Candidate ancestry does not waive a missing SQLite operation result.
    const scope = { time: started.time, child: created.child, databases: [] };
    writeJson(path.join(f.spec.directory, "handoff.json"), scope);
    const parentExit = parentRows.at(-1);
    assert(parentExit?.event === "exit");
    rewrite(parentLog, [
      ...parentRows.slice(0, -1),
      { ...parentExit, event: "handoff", ...scope },
      parentExit,
    ]);
    rewrite(childLog, childRows);
    expect(() => readInstalledTerminalEvents(f.spec.directory)).not.toThrow();
    rewrite(
      childLog,
      childRows.filter((row) => row.event !== "sqlite-construct"),
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("observation interrupted");
  },
);

it.skipIf(process.platform !== "linux")(
  "observes final absence after a real child creator is terminated",
  async () => {
    for (const instrumented of [false, true]) {
      const f = fixture();
      const child = path.join(f.root, "orphan-child.cjs");
      const worker = path.join(f.root, "orphan-worker.mjs");
      const parent = path.join(f.root, "orphan-parent.mjs");
      const release = path.join(f.root, "release");
      const identity = path.join(f.root, "child.json");
      fs.writeFileSync(
        child,
        `
      const fs = require('node:fs');
      setTimeout(() => process.exit(2), 5000);
      setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
      process.on('disconnect', () => {});
      process.send('ready');
    `,
      );
      fs.writeFileSync(
        worker,
        `
      import {spawn} from 'node:child_process';
      import {parentPort} from 'node:worker_threads';
      const child = spawn(process.execPath, [${JSON.stringify(child)}], {detached:true,stdio:['ignore','inherit','inherit','ipc']});
      child.once('message', () => parentPort.postMessage(child.pid));
    `,
      );
      fs.writeFileSync(
        parent,
        `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import {Worker} from 'node:worker_threads';
      const worker = new Worker(${JSON.stringify(worker)});
      const pid = await new Promise(resolve => worker.once('message', resolve));
      assert.equal(await worker.terminate(), 1);
      process.kill(pid, 0);
      fs.writeFileSync(${JSON.stringify(identity)}, JSON.stringify({pid}));
      fs.writeFileSync(${JSON.stringify(release)}, 'release');
      console.log('creator-terminated');
    `,
      );
      const result = runProcess(
        node,
        [parent],
        instrumented
          ? f.env
          : {
              ...process.env,
              NODE_OPTIONS: "",
              OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "",
            },
        10_000,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("creator-terminated\n");
      const { pid } = JSON.parse(fs.readFileSync(identity, "utf8"));
      assert(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0);
      // Fixture preparation waits for the actual orphan to be reaped; the proof
      // capture itself remains one shot and never waits or signals a live child.
      let absent = false;
      const deadline = Date.now() + 1000;
      while (!absent && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          assert(error instanceof Error && "code" in error && error.code === "ESRCH");
          absent = true;
        }
        if (!absent) {
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
      }
      expect(absent).toBe(true);
      if (instrumented) {
        expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow(
          "no unique native exit",
        );
        const processAbsence = captureNodeProcessAbsence(f.spec.directory);
        expect(processAbsence).toHaveLength(1);
        expect(processAbsence[0]).toMatchObject({
          child: pid,
          errorCode: "ESRCH",
          ownExitCode: null,
        });
        const rows = readInstalledTerminalEvents(f.spec.directory, { processAbsence });
        expect(rows.some((row) => row.event === "spawn-exit" && row.child === pid)).toBe(false);
        expect(
          rows.find((row) => row.event === "spawn" && row.child === pid)?.lifetimeBound,
        ).toEqual(processAbsence[0]);
      }
    }
  },
);

it("bounds suppressed Worker callbacks by actual enclosing native teardown", () => {
  for (const ending of ["process", "worker"]) {
    const f = fixture();
    const leaf = path.join(f.root, "teardown-leaf.mjs");
    const middle = path.join(f.root, "teardown-middle.mjs");
    const actor = path.join(f.root, "teardown-actor.mjs");
    const script = path.join(f.root, "teardown-parent.mjs");
    fs.writeFileSync(
      leaf,
      "import {parentPort} from 'node:worker_threads'; parentPort.postMessage('ready'); setInterval(() => {}, 1000);",
    );
    fs.writeFileSync(
      middle,
      `import {Worker, parentPort} from 'node:worker_threads';
       const child = new Worker(${JSON.stringify(leaf)});
       child.once('message', () => parentPort.postMessage('ready'));`,
    );
    fs.writeFileSync(
      actor,
      `import {Worker} from 'node:worker_threads';
       const child = new Worker(${JSON.stringify(middle)});
       await new Promise(resolve => child.once('message', resolve));
       ${ending === "worker" ? "await child.terminate();" : "process.exit(0);"}`,
    );
    fs.writeFileSync(
      script,
      `import {spawn} from 'node:child_process';
       const child = spawn(process.execPath, [${JSON.stringify(actor)}], {stdio:'inherit'});
       child.once('close', code => { console.log('joined:' + code); });`,
    );
    const plain = runProcess(
      node,
      [script],
      { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
      10_000,
    );
    const observed = runProcess(node, [script], f.env, 10_000);
    expect(plain.status, plain.stderr).toBe(0);
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout).toBe(plain.stdout);
    expect(observed.stdout).toBe("joined:0\n");
    const original = new Map(
      fs
        .readdirSync(f.spec.directory)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => [
          name,
          readJsonLines<Record<string, unknown>>(path.join(f.spec.directory, name)),
        ]),
    );
    const rows = [...original.values()].flat();
    const parent = rows.find((row) => row.event === "startup" && row.entry === script);
    const spawned = rows.find((row) => row.event === "spawn");
    const created = rows.filter((row) => row.event === "thread");
    const leafStart = rows.find((row) => row.event === "startup" && row.entry === leaf);
    assert(parent && spawned && leafStart && typeof parent.pid === "number");
    assert(typeof spawned.child === "number" && typeof leafStart.pid === "number");
    assert(typeof leafStart.thread === "number");
    expect(created).toHaveLength(2);
    expect(rows.filter((row) => row.event === "thread-exit")).toHaveLength(
      ending === "worker" ? 1 : 0,
    );
    const parentExit = rows.find((row) => row.event === "exit" && row.pid === parent.pid);
    assert(parentExit && typeof parentExit.time === "string");
    const scope = { time: String(BigInt(parentExit.time) - 1n), child: -1, databases: [] };
    const rewrite = (change: (events: Record<string, unknown>[]) => Record<string, unknown>[]) => {
      writeJson(path.join(f.spec.directory, "handoff.json"), scope);
      for (const [name, events] of original) {
        const terminal = events.at(-1);
        assert(terminal);
        const current =
          events[0]?.pid === parent.pid
            ? [...events.slice(0, -1), { ...terminal, event: "handoff", ...scope }, terminal]
            : events;
        fs.writeFileSync(
          path.join(f.spec.directory, name),
          change(current)
            .map((row, sequence) => JSON.stringify({ ...row, sequence }))
            .join("\n") + "\n",
        );
      }
    };
    rewrite((events) => events);
    const qualified = readInstalledTerminalEvents(f.spec.directory);
    const bounded = qualified.filter((row) => row.lifetimeBound);
    expect(bounded).toHaveLength(ending === "worker" ? 1 : 2);
    for (const row of bounded) {
      expect(row.lifetimeBound).toMatchObject({
        ownExitCode: null,
        reason: "settled-before-handoff",
      });
    }
    expect(bounded.at(-1)?.lifetimeBound).toMatchObject({ sourceKind: `${ending}-native-exit` });

    const bound = bounded.at(-1)?.lifetimeBound;
    assert(bound && typeof bound === "object" && "time" in bound && typeof bound.time === "string");
    const late = {
      ...leafStart,
      event: "sqlite-intent",
      operation: 0,
      time: String(BigInt(bound.time) + 1n),
    };
    rewrite((events) =>
      events[0]?.pid === leafStart.pid && events[0]?.thread === leafStart.thread
        ? [...events, late]
        : events,
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow(
      "exceeds enclosing native bound",
    );
    rewrite((events) =>
      events.filter((row) => row.event !== "spawn-exit" && row.event !== "thread-exit"),
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("no unique native exit");
    rewrite((events) =>
      events.flatMap((row) =>
        row.event === "spawn-exit" || row.event === "thread-exit" ? [row, row] : [row],
      ),
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("no unique native exit");

    const firstCreated = created[0];
    assert(firstCreated && typeof firstCreated.time === "string");
    scope.time = String(BigInt(firstCreated.time) - 1n);
    rewrite((events) => events);
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("spans predecessor window");
    scope.child = spawned.child;
    rewrite((events) => events);
    for (const row of readInstalledTerminalEvents(f.spec.directory).filter(
      (event) => event.lifetimeBound,
    )) {
      expect(row.lifetimeBound).toMatchObject({ reason: "candidate-subtree" });
    }
    rewrite((events) =>
      events[0]?.pid === leafStart.pid && events[0]?.thread === leafStart.thread
        ? [...events, { ...leafStart, event: "sqlite-intent", operation: 0 }]
        : events,
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("observation interrupted");
    rewrite((events) =>
      events[0]?.pid === leafStart.pid && events[0]?.thread === leafStart.thread
        ? [...events, { ...leafStart, event: "spawn", spawnId: 0, child: 999999, nodeChild: false }]
        : events,
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("no unique native exit");
  }
});

it("exports compact launch summaries with exact raw references and unchanged bounds", () => {
  const rows: Record<string, unknown>[] = [
    { event: "startup", pid: 100, thread: 0, sequence: 0, time: "1" },
  ];
  for (let childThread = 1; childThread <= 20; childThread++) {
    rows.push({
      event: "thread",
      pid: 100,
      thread: 0,
      sequence: rows.length,
      childThread,
      time: String(childThread * 2),
      entry: "file:///fixture/heartbeat.js",
      packageHeartbeat: { source: "retained helper body\n".repeat(1800), sha256: "a".repeat(64) },
      coverage: { role: "state-lease-heartbeat", reason: "settled-before-handoff" },
    });
    rows.push({
      event: "thread-exit",
      pid: 100,
      thread: 0,
      sequence: rows.length,
      childThread,
      code: 0,
      time: String(childThread * 2 + 1),
    });
  }
  rows.push({
    event: "spawn",
    pid: 100,
    thread: 0,
    sequence: rows.length,
    spawnId: 0,
    child: 200,
    time: "50",
    packageEntry: { source: "exact probe" },
    coverage: { role: "node-runtime-probe", reason: "settled-before-handoff" },
  });
  for (const event of ["spawn-exit", "spawn-close"]) {
    rows.push({
      event,
      pid: 100,
      thread: 0,
      sequence: rows.length,
      spawnId: 0,
      child: 200,
      code: 0,
      signal: null,
      time: "60",
    });
  }
  rows.push({ event: "handoff", pid: 100, thread: 0, sequence: rows.length, time: "100" });
  assert(rows[1]);
  rows[1].lifetimeBound = { sourceKind: "process-native-exit", ownExitCode: null, time: "80" };
  const raw = rows.map(({ coverage: _coverage, lifetimeBound: _bound, ...event }) => event);
  assert(raw[1]);
  const projection = summarizeInstalledTerminalLaunches(rows);
  expect(projection.workersWithoutPreload).toHaveLength(20);
  expect(projection.workersWithoutPreload[0]).toMatchObject({
    pid: 100,
    creatorThread: 0,
    thread: 1,
    exitCode: 0,
    joinedBeforeHandoff: true,
    coverage: rows[1].coverage,
    evidence: {
      source: "100-0.jsonl",
      sequence: 1,
      event: "thread",
      sha256: createHash("sha256").update(JSON.stringify(raw[1])).digest("hex"),
    },
  });
  expect(projection.processesWithoutPreload[0]).toMatchObject({
    pid: 200,
    creatorPid: 100,
    creatorThread: 0,
    spawnId: 0,
    nativeSettlement: [expect.any(Object), expect.any(Object)],
  });
  expect(projection.workerLifetimeBounds[0]?.bound).toEqual(rows[1].lifetimeBound);
  expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(512 * 1024);
  const summary = { status: "passed", cells: [{ name: "healthy", ...projection }] };
  const bundle = (events = raw, lifecycle = raw) => {
    const artifacts = new Map([
      [
        "healthy-observer.jsonl.gz",
        gzipSync(events.map((event) => JSON.stringify(event)).join("\n") + "\n"),
      ],
      [
        "healthy-lifetimes.jsonl.gz",
        gzipSync(
          JSON.stringify({ name: "100-0.jsonl", recordsComplete: true, events: lifecycle }) +
            "\n" +
            JSON.stringify({
              status: "complete",
              omittedFiles: 0,
            }) +
            "\n",
        ),
      ],
    ]);
    const manifest = {
      status: "complete",
      omissions: [],
      files: [...artifacts].map(([name, bytes]) => ({
        name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const read = (name: string) => {
      const value = artifacts.get(name);
      assert(value);
      return value;
    };
    return { artifacts, manifest, bytes, read };
  };
  const evidence = bundle();
  const original = [...evidence.artifacts].map(([name, bytes]) => [name, Buffer.from(bytes)]);
  const result = buildInstalledTerminalSummary(summary, evidence.bytes, evidence.read);
  expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThan(32 * 1024);
  expect(result.evidence).toEqual({
    manifest: "manifest.json",
    bytes: evidence.bytes.length,
    sha256: createHash("sha256").update(evidence.bytes).digest("hex"),
  });
  expect([...evidence.artifacts]).toEqual(original);
  const lifecycleOnly = bundle(raw.filter((event) => event.sequence !== 1));
  expect(() =>
    buildInstalledTerminalSummary(summary, lifecycleOnly.bytes, lifecycleOnly.read),
  ).not.toThrow();

  for (const [field, value] of [
    ["source", "999-0.jsonl"],
    ["sequence", 999],
    ["event", "spawn"],
    ["sha256", "0".repeat(64)],
  ] as const) {
    const changed = structuredClone(summary);
    const reference = changed.cells[0]?.workersWithoutPreload[0]?.evidence;
    assert(reference && typeof reference === "object");
    Object.assign(reference, { [field]: value });
    expect(
      () => buildInstalledTerminalSummary(changed, evidence.bytes, evidence.read),
      field,
    ).toThrow();
  }
  expect(() =>
    buildInstalledTerminalSummary(
      { ...summary, cells: [{ ...summary.cells[0], name: "late-failure" }] },
      evidence.bytes,
      evidence.read,
    ),
  ).toThrow("Missing summary evidence");
  const missing = bundle(
    raw.filter((event) => event.sequence !== 1),
    raw.filter((event) => event.sequence !== 1),
  );
  expect(() => buildInstalledTerminalSummary(summary, missing.bytes, missing.read)).toThrow(
    "Missing summary event",
  );
  const duplicate = bundle([...raw, raw[1]]);
  expect(() => buildInstalledTerminalSummary(summary, duplicate.bytes, duplicate.read)).toThrow(
    "Duplicate summary event",
  );
  const changed = structuredClone(raw);
  assert(changed[1]);
  changed[1].packageHeartbeat = { source: "changed helper", sha256: "a".repeat(64) };
  const conflicting = bundle(raw, changed);
  expect(() => buildInstalledTerminalSummary(summary, conflicting.bytes, conflicting.read)).toThrow(
    "Conflicting summary event",
  );
  const tampered = bundle(changed, changed);
  expect(() => buildInstalledTerminalSummary(summary, tampered.bytes, tampered.read)).toThrow(
    "Changed summary event digest",
  );
  assert(evidence.manifest.files[0]);
  evidence.manifest.files[0].sha256 = "0".repeat(64);
  expect(() =>
    buildInstalledTerminalSummary(
      summary,
      Buffer.from(JSON.stringify(evidence.manifest)),
      evidence.read,
    ),
  ).toThrow("Changed summary evidence");
  expect(() =>
    buildInstalledTerminalSummary(
      { ...summary, unrelated: "x".repeat(512 * 1024) },
      evidence.bytes,
      evidence.read,
    ),
  ).toThrow("Terminal summary exceeds 512 KiB");
});

it("exports complete command and isolate bytes with a bounded artifact census", () => {
  const root = dirs.make("installed-terminal-evidence-");
  writeJson(path.join(root, "candidate-package-identity.json"), {});
  writeJson(path.join(root, "package-hasher-contract.json"), {});
  writeJson(path.join(root, "package-heartbeat-contracts.json"), {});
  writeJson(path.join(root, "installed-terminal-contracts.json"), {});
  writeJson(path.join(root, "healthy-dependencies.json"), {});
  const output = Buffer.from("actual command failure\n");
  fs.writeFileSync(path.join(root, "healthy-update.out"), Buffer.alloc(0));
  fs.writeFileSync(path.join(root, "healthy-update.err"), output);
  fs.mkdirSync(path.join(root, "healthy"));
  writeJson(path.join(root, "healthy/observer.json"), {});
  const first = Buffer.from('{"event":"startup"}\n');
  const interrupted = Buffer.from('{"event":"sqlite-intent"');
  fs.writeFileSync(path.join(root, "healthy/1-0.jsonl"), first);
  fs.writeFileSync(path.join(root, "healthy/1-1.jsonl"), interrupted);
  publishInstalledTerminalEvidence(root, {
    status: "failed",
    commands: [{ name: "healthy-update" }],
    cells: [{ name: "healthy" }],
  });
  expect(gunzipSync(fs.readFileSync(path.join(root, "export/healthy-update.err.gz")))).toEqual(
    output,
  );
  expect(gunzipSync(fs.readFileSync(path.join(root, "export/healthy-observer.jsonl.gz")))).toEqual(
    Buffer.concat([first, interrupted]),
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "export/manifest.json"), "utf8"));
  expect(manifest.status).toBe("complete");
  expect(manifest.omissions).toEqual([]);
  expect(
    manifest.files.find((row: { name: string }) => row.name === "healthy-observer.jsonl.gz")
      .sources,
  ).toEqual([
    {
      name: "healthy/1-0.jsonl",
      bytes: first.length,
      sha256: createHash("sha256").update(first).digest("hex"),
    },
    {
      name: "healthy/1-1.jsonl",
      bytes: interrupted.length,
      sha256: createHash("sha256").update(interrupted).digest("hex"),
    },
  ]);
  expect(fs.readFileSync(path.join(root, "healthy/1-1.jsonl"))).toEqual(interrupted);
});

it.each(["budget", "sink", "truncate"])(
  "keeps native I/O and errors intact after observer %s failure",
  (failure) => {
    const f = fixture();
    const script = path.join(f.root, "observer-failure.cjs");
    fs.writeFileSync(
      script,
      `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { DatabaseSync } = require('node:sqlite');
    if (${JSON.stringify(failure)} === 'sink') {
      const write = fs.writeSync;
      fs.writeSync = function(...args) {
        if (typeof args[1] === 'string' && args[1].startsWith('{"event":')) throw new Error('observer sink refused');
        return Reflect.apply(write, this, args);
      };
    } else if (${JSON.stringify(failure)} === 'truncate') {
      fs.writeFileSync(${JSON.stringify(path.join(f.spec.directory, "handoff.json"))}, JSON.stringify({time:'1',child:99999,databases:[]}));
      fs.ftruncateSync = () => { throw new Error('observer truncate refused'); };
      const db = new DatabaseSync(':memory:'); db.close();
    } else {
      for (let i = 0; i < 8200; i++) process.stdout.write('');
    }
    const sentinel = new Error('native getter error');
    let reads = 0;
    try { new DatabaseSync(':memory:', {get open(){reads++; throw sentinel;}}); assert.fail('missing native error'); }
    catch(error) { assert.equal(error, sentinel); }
    assert.equal(reads, 1);
    process.stdout.write('native output\\n', () => {
      process.stdout.write('native callback\\n');
      process.on('uncaughtException', error => process.stdout.write(error.message + '\\n'));
      setImmediate(() => { throw new Error('original CLI exception'); });
    });
  `,
    );
    const result = runProcess(node, [script], f.env, 10_000);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("native output\nnative callback\noriginal CLI exception\n");
    const shared = JSON.parse(
      fs.readFileSync(path.join(f.spec.directory, "observer-failed.json"), "utf8"),
    );
    expect(shared).toMatchObject({ status: "unqualified" });
    expect(shared.error).toContain(
      failure === "budget" ? "observer budget exceeded" : `observer ${failure} refused`,
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("coverage is unqualified");
    expect(fs.existsSync(path.join(f.spec.directory, "launcher-intent.json"))).toBe(false);
  },
);

// Report the first package qualification failure before dependent creation assertions.
function packageRecords(f: ReturnType<typeof fixture>) {
  const failure = path.join(f.spec.directory, "observer-failed.json");
  if (fs.existsSync(failure)) {
    assert.fail(fs.readFileSync(failure, "utf8"));
  }
  const rows = f.records();
  expect(rows).toContainEqual(expect.objectContaining({ event: "heartbeat-package" }));
  return rows;
}

function publishedHelperFixture() {
  const f = fixture();
  const root = path.join(f.root, "prefix/openclaw");
  const helpers: {
    sourceCommit: string;
    files: Record<string, { source: string; sha256: string }>;
    sqliteProbe: string;
    copyProgress: string;
  } = JSON.parse(
    fs.readFileSync("test/fixtures/installed-terminal-historical-helpers.json", "utf8"),
  );
  const heartbeat = "dist/state/openclaw-state-lease-heartbeat.worker.js";
  fs.mkdirSync(path.join(root, "dist/state"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, heartbeat), "// unused fixture heartbeat\n");
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "await import('./dist/parent.mjs');\n");
  writeJson(path.join(root, "package.json"), { name: "openclaw", version: "2026.10.9" });
  writeJson(path.join(root, "dist/build-info.json"), {
    version: "2026.10.9",
    commit: helpers.sourceCommit,
  });
  for (const [name, value] of Object.entries(helpers.files)) {
    expect(createHash("sha256").update(value.source).digest("hex")).toBe(value.sha256);
    fs.writeFileSync(path.join(root, name), value.source);
  }
  const base = path.join(f.root, "compile-cache");
  const target = path.join(base, "openclaw/2026.10.9/build-fixture");
  fs.mkdirSync(target, { recursive: true });
  const preloadMarker = path.join(f.root, "published-preload-ran");
  const preload = path.join(f.root, "published-preload.cjs");
  fs.writeFileSync(
    preload,
    `require('node:fs').appendFileSync(${JSON.stringify(preloadMarker)}, 'ran');`,
  );
  const parent = path.join(root, "dist/parent.mjs");
  fs.writeFileSync(
    parent,
    `
    import assert from 'node:assert/strict';
    import {once} from 'node:events';
    import {Worker} from 'node:worker_threads';
    import {spawn} from 'node:child_process';
    const mode = process.argv[2] ?? 'normal';
    let reads = 0, traps = 0;
    const env = {NODE_COMPILE_CACHE:${JSON.stringify(base)}};
    const workerData = {openclawCompileCacheDirectory:${JSON.stringify(target)}};
    const probe = ${JSON.stringify(helpers.sqliteProbe)};
    for (const [entry, options] of [
      [probe, {eval:true, execArgv:[], env}],
      [new URL(${JSON.stringify(pathToFileURL(path.join(root, "node-compile-cache.mjs")).href)}), {workerData, execArgv:[], env}],
    ]) {
      let input = options;
      if (mode === 'options-accessor') input = {...options, get env(){reads++; return env;}};
      if (mode === 'options-proxy') input = new Proxy(options, {get(t,k,r){traps++; return Reflect.get(t,k,r);}});
      if (mode === 'env-accessor') input.env = {get NODE_COMPILE_CACHE(){reads++; return env.NODE_COMPILE_CACHE;}};
      if (mode === 'env-proxy') input.env = new Proxy(env, {ownKeys(t){traps++; return Reflect.ownKeys(t);}});
      if (mode === 'data-accessor' && options.workerData) input.workerData = {get openclawCompileCacheDirectory(){reads++; return workerData.openclawCompileCacheDirectory;}};
      if (mode === 'data-proxy' && options.workerData) input.workerData = new Proxy(workerData, {});
      if (mode === 'worker-loader') input.env = {NODE_OPTIONS:'--no-warnings'};
      if (mode === 'worker-argument') input.execArgv = ['--no-warnings'];
      // Node24 consumes the third env/execArgv read; rewrite only after selecting that value.
      if (mode === 'argv-rewrite' || mode === 'env-rewrite') {
        let launchReads = 0;
        const key = mode === 'argv-rewrite' ? 'execArgv' : 'env';
        const safe = key === 'execArgv' ? [] : env;
        Object.defineProperty(input, key, {configurable:true, get(){
          reads++; launchReads++;
          if (launchReads < 3) return safe;
          Object.defineProperty(input,key,{value:safe,configurable:true,enumerable:true});
          return key === 'execArgv' ? ['--require',${JSON.stringify(preload)}] : {...env,NODE_OPTIONS:${JSON.stringify(`--require=${preload}`)}};
        }});
      }
      const worker = new Worker(entry, input);
      assert.equal((await once(worker, 'exit'))[0], 0);
    }
    const childEnv = mode === 'node-loader' ? {NODE_OPTIONS:'--no-warnings'} : mode === 'native-loader' ? {LD_LIBRARY_PATH:${JSON.stringify(f.root)}} : mode === 'wrong-spec-loader' ? {NODE_OPTIONS:${JSON.stringify(`--import=${observer}`)},OPENCLAW_INSTALLED_TERMINAL_OBSERVER:${JSON.stringify(path.join(f.root, "wrong-spec.json"))}} : {};
    const childOptions = {env:childEnv,stdio:['pipe','ignore','inherit']};
    const childArgv = ['--input-type=commonjs','--eval',${JSON.stringify(helpers.copyProgress)}];
    if(mode==='progress-non-enumerable-env') Object.defineProperty(childOptions,'env',{value:childEnv,enumerable:false});
    if(mode==='progress-env-rewrite') Object.defineProperty(childOptions,'env',{enumerable:true,configurable:true,get(){reads++;Object.defineProperty(childOptions,'env',{value:childEnv,enumerable:true,configurable:true});return {NODE_OPTIONS:${JSON.stringify(`--require=${preload}`)}};}});
    if(mode==='progress-argv-rewrite') Object.defineProperty(childArgv,2,{configurable:true,get(){reads++;Object.defineProperty(childArgv,2,{value:${JSON.stringify(helpers.copyProgress)},configurable:true});return 'require('+${JSON.stringify(JSON.stringify(preload))}+');'+${JSON.stringify(helpers.copyProgress)};}});
    if(mode==='progress-cwd-mutation') {childOptions.cwd=new URL(${JSON.stringify(pathToFileURL(f.root).href)});Object.defineProperty(childOptions.cwd,'protocol',{get(){reads++;childEnv.NODE_OPTIONS=${JSON.stringify(`--require=${preload}`)};return 'file:';}});}
    const child = spawn(process.execPath, childArgv, childOptions);
    if (mode === 'killed') { await once(child,'spawn'); child.kill('SIGKILL'); }
    else child.stdin.end(JSON.stringify({directory:${JSON.stringify(target)}}));
    const [code,signal] = await once(child,'close');
    assert.equal(code, mode === 'killed' ? null : 0);
    assert.equal(signal, mode === 'killed' ? 'SIGKILL' : null);
    console.log(JSON.stringify({reads,traps}));
  `,
  );
  const identity = readWorkerCellPackageIdentity(root);
  const inventory = path.join(f.root, "inventory.json");
  writeJson(inventory, identity);
  const contract = {
    ...readInstalledTerminalHeartbeat(root, identity),
    dependencies: readInstalledTerminalDependencyTree(path.join(root, "node_modules")),
    dependencyReferenceSha256: "1".repeat(64),
    inventory: {
      path: inventory,
      sha256: createHash("sha256").update(fs.readFileSync(inventory)).digest("hex"),
    },
  };
  const spec = {
    ...f.spec,
    root,
    historical: true,
    compileCacheBase: base,
    stateDatabase: path.join(f.root, "state/openclaw.sqlite"),
    agentDatabase: path.join(f.root, "agent/openclaw-agent.sqlite"),
    journal: path.join(f.root, "control/operation.sqlite"),
    heartbeatWorkers: [contract],
  };
  writeJson(path.join(f.root, "spec.json"), spec);
  const clear = () => {
    for (const file of fs.readdirSync(spec.directory)) {
      fs.unlinkSync(path.join(spec.directory, file));
    }
  };
  return { ...f, spec, parent, base, target, clear, preloadMarker };
}

it.skipIf(process.platform !== "linux").each(["normal", "killed"])(
  "qualifies exact published helper launches with direct native settlement (%s)",
  (mode) => {
    const f = publishedHelperFixture();
    const plain = runProcess(node, [f.parent, mode], process.env, 10_000);
    const observed = runProcess(node, [f.parent, mode], f.env, 10_000);
    expect(plain.status, plain.stderr).toBe(0);
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout).toBe(plain.stdout);
    const rows = packageRecords(f);
    expect(rows.filter((row) => row.event === "startup")).toHaveLength(1);
    const created = rows.filter((row) => row.event === "thread" || row.event === "spawn");
    expect(created).toHaveLength(3);
    expect(created.map((row) => row.packageEntry)).toEqual([
      expect.objectContaining({ role: "published-sqlite-probe" }),
      expect.objectContaining({ role: "published-compile-cache" }),
      expect.objectContaining({ role: "published-copy-progress" }),
    ]);
    const parent = rows.find((row) => row.event === "startup");
    const close = rows.find((row) => row.event === "spawn-close");
    const exit = rows.at(-1);
    assert(
      parent &&
        typeof parent.pid === "number" &&
        close &&
        typeof close.time === "string" &&
        exit?.event === "exit",
    );
    expect(close).toMatchObject({
      code: mode === "killed" ? null : 0,
      signal: mode === "killed" ? "SIGKILL" : null,
    });
    const parentPid = parent.pid;
    const handoff = {
      pid: parentPid,
      thread: 0,
      event: "handoff",
      time: String(BigInt(close.time) + 1n),
      child: 999999,
      databases: [],
    };
    const original = [...rows.slice(0, -1), handoff, exit];
    const rewrite = (events: Record<string, unknown>[]) =>
      fs.writeFileSync(
        path.join(f.spec.directory, `${parentPid}-0.jsonl`),
        events.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
      );
    writeJson(path.join(f.spec.directory, "handoff.json"), {
      time: handoff.time,
      child: handoff.child,
      databases: [],
    });
    rewrite(original);
    expect(
      readInstalledTerminalEvents(f.spec.directory, f.spec).filter((row) => row.coverage),
    ).toHaveLength(3);
    expect(() =>
      readInstalledTerminalEvents(f.spec.directory, { ...f.spec, historical: false }),
    ).toThrow();
    const change = (target: unknown, patch: Record<string, unknown>) =>
      original.map((row) => (row === target ? Object.assign({}, row, patch) : row));
    for (const launch of created) {
      assert(launch.packageEntry && typeof launch.packageEntry === "object");
      const packageEntry = launch.packageEntry;
      const end = rows.find((row) =>
        launch.event === "thread"
          ? row.event === "thread-exit" && row.childThread === launch.childThread
          : row.event === "spawn-exit",
      );
      assert(end);
      for (const invalid of [
        original.filter((row) => row !== end),
        [...original.slice(0, -1), end, exit],
        change(end, { code: 1, signal: null }),
        change(end, { time: handoff.time }),
        change(launch, { entry: "unreviewed", argv: ["--eval", "unreviewed"] }),
        ...[
          { sourceCommit: "0".repeat(40) },
          { root: "/foreign" },
          { rootIdentity: "1:2" },
          { inventorySha256: "f".repeat(64) },
          { environmentQualified: false },
          {
            inheritedCache: {
              base: f.base,
              directory: "/foreign",
              ancestorsPhysical: true,
              stateDisjoint: true,
            },
          },
          ...(launch.event === "thread"
            ? [{ rootEntry: { source: "changed" } }]
            : [{ sha256: "f".repeat(64) }]),
        ].map((patch) => change(launch, { packageEntry: { ...packageEntry, ...patch } })),
      ]) {
        rewrite(invalid);
        expect(() => readInstalledTerminalEvents(f.spec.directory, f.spec)).toThrow();
      }
    }
    const native = rows.find((row) => row.event === "spawn-exit");
    assert(native);
    for (const invalid of [
      original.filter((row) => row !== close),
      [...original.slice(0, -1), close, exit],
      change(close, { child: -1 }),
      change(close, { signal: "SIGTERM", code: null }),
      original.map((row) =>
        row === native || row === close
          ? Object.assign({}, row, { code: null, signal: "SIGTERM" })
          : row,
      ),
      // A known helper cannot hide a recorded escaping child.
      [
        ...original.slice(0, -1),
        { ...native, event: "spawn", spawnId: 99, child: 999998, nodeChild: false },
        exit,
      ],
    ]) {
      rewrite(invalid);
      expect(() => readInstalledTerminalEvents(f.spec.directory, f.spec)).toThrow();
    }
    rewrite(original);
    expect(
      readInstalledTerminalEvents(f.spec.directory, f.spec).find(
        (row) => row.event === "spawn-exit",
      ),
    ).toMatchObject({
      code: mode === "killed" ? null : 0,
      signal: mode === "killed" ? "SIGKILL" : null,
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "refuses unsafe published helper launch metadata without additional native reads",
  () => {
    const f = publishedHelperFixture();
    for (const mode of [
      "options-accessor",
      "options-proxy",
      "env-accessor",
      "env-proxy",
      "data-accessor",
      "data-proxy",
      "worker-loader",
      "worker-argument",
      "argv-rewrite",
      "env-rewrite",
      "node-loader",
      "native-loader",
      "wrong-spec-loader",
      "progress-non-enumerable-env",
      "progress-env-rewrite",
      "progress-argv-rewrite",
      "progress-cwd-mutation",
    ]) {
      f.clear();
      fs.rmSync(f.preloadMarker, { force: true });
      const plain = runProcess(node, [f.parent, mode], process.env, 10_000);
      if (mode.endsWith("rewrite") || mode === "progress-cwd-mutation") {
        expect(fs.readFileSync(f.preloadMarker, "utf8"), mode).toBe(
          mode.startsWith("progress-") ? "ran" : "ranran",
        );
      }
      fs.rmSync(f.preloadMarker, { force: true });
      const observed = runProcess(node, [f.parent, mode], f.env, 10_000);
      expect(observed.status).toBe(plain.status);
      expect(observed.stdout).toBe(plain.stdout);
      if (mode.endsWith("rewrite") || mode === "progress-cwd-mutation") {
        expect(fs.readFileSync(f.preloadMarker, "utf8"), mode).toBe(
          mode.startsWith("progress-") ? "ran" : "ranran",
        );
      }
      if (mode === "data-proxy") {
        // Node itself refuses cloning a Proxy. Observation must preserve that throw.
        expect(observed.status).not.toBe(0);
        continue;
      }
      expect(observed.status, observed.stderr).toBe(0);
      const launches = packageRecords(f).filter(
        (row) => row.event === "thread" || row.event === "spawn",
      );
      const target =
        (mode.endsWith("loader") && mode !== "worker-loader") || mode.startsWith("progress-")
          ? launches.at(-1)
          : mode === "data-accessor"
            ? launches[1]
            : launches[0];
      assert(target);
      expect(target.packageEntry).toBeUndefined();
      if (mode === "progress-non-enumerable-env") {
        // Node ignores the hidden env and inherits preload. The explicit-env
        // contract stays unqualified; ordinary startup evidence remains available.
        expect(f.records()).toContainEqual(
          expect.objectContaining({ event: "startup", pid: target.child }),
        );
      }
    }
    for (const location of ["foreign", "escape-return", "state-overlap"]) {
      f.clear();
      const foreign = path.join(f.root, `outside-${location}`);
      fs.mkdirSync(foreign);
      if (location === "foreign") {
        fs.renameSync(f.base, `${f.base}-original`);
        fs.symlinkSync(foreign, f.base);
      } else if (location === "escape-return") {
        fs.renameSync(path.join(f.base, "openclaw"), path.join(f.base, "retained"));
        fs.symlinkSync(path.join(f.base, "retained"), path.join(foreign, "return"));
        fs.symlinkSync(path.join(foreign, "return"), path.join(f.base, "openclaw"));
      } else {
        writeJson(path.join(f.root, "spec.json"), {
          ...f.spec,
          stateDatabase: path.join(f.base, "state/openclaw.sqlite"),
        });
      }
      const observed = runProcess(node, [f.parent], f.env, 10_000);
      expect(observed.status, observed.stderr).toBe(0);
      const threads = f.records().filter((row) => row.event === "thread");
      expect(threads, location).toHaveLength(2);
      const cache = threads.find(
        (row) => row.entry === pathToFileURL(path.join(f.spec.root, "node-compile-cache.mjs")).href,
      );
      const probe = threads.find(
        (row) =>
          typeof row.entry === "string" &&
          createHash("sha256").update(row.entry).digest("hex") ===
            "59e299b2d4e33c5cc0aef06eb87fc986906d69cae24d2f72daa0f179da75a322",
      );
      assert(cache && probe, location);
      expect(cache.packageEntry, `${location}: cache Worker`).toBeUndefined();
      if (location === "escape-return") {
        // This link affects the maintenance target, not the probe's physical base.
        expect(probe.packageEntry, `${location}: memory probe`).toMatchObject({
          role: "published-sqlite-probe",
        });
      } else {
        expect(probe.packageEntry, `${location}: memory probe`).toBeUndefined();
      }
      if (location === "foreign") {
        fs.unlinkSync(f.base);
        fs.renameSync(`${f.base}-original`, f.base);
      } else if (location === "escape-return") {
        fs.unlinkSync(path.join(f.base, "openclaw"));
        fs.renameSync(path.join(f.base, "retained"), path.join(f.base, "openclaw"));
      }
    }
  },
);

it.each([false, true])(
  "exports diagnostic isolate classification without admitting excessive coverage: %s",
  (capped) => {
    const root = dirs.make("installed-terminal-diagnostic-census-");
    writeJson(path.join(root, "candidate-package-identity.json"), {});
    writeJson(path.join(root, "package-hasher-contract.json"), {});
    writeJson(path.join(root, "package-heartbeat-contracts.json"), {});
    writeJson(path.join(root, "installed-terminal-contracts.json"), {});
    writeJson(path.join(root, "healthy-dependencies.json"), {});
    fs.mkdirSync(path.join(root, "healthy"));
    for (let index = 1; index <= 521; index++) {
      fs.writeFileSync(
        path.join(root, "healthy", `${index}-0.jsonl`),
        JSON.stringify({
          event: "startup",
          pid: index,
          thread: 0,
          entry: capped ? `/worker-${index}.js` : "/worker.js",
        }) + "\n",
      );
    }
    expect(() =>
      publishInstalledTerminalEvidence(root, {
        status: "failed",
        commands: [],
        cells: [{ name: "healthy" }],
      }),
    ).toThrow("521 isolates");
    const census = JSON.parse(
      fs.readFileSync(path.join(root, "export/healthy-isolate-census.json"), "utf8"),
    );
    expect(census).toMatchObject({
      diagnosticOnly: true,
      files: 521,
      inspected: 521,
      unknown: 0,
      status: capped ? "capped" : "complete",
    });
    expect(census.groups).toHaveLength(capped ? 64 : 1);
    expect(census.omissions).toBe(capped ? 457 : 0);
    if (!capped) {
      expect(census.groups[0]).toMatchObject({ entry: "/worker.js", isolates: 521 });
    }
    expect(() => readInstalledTerminalEvents(path.join(root, "healthy"))).toThrow("excessive");
    expect(fs.existsSync(path.join(root, "export/healthy-observer.jsonl.gz"))).toBe(false);
  },
);

it("retains a visible failed export receipt when the aggregate byte bound is exceeded", () => {
  const root = dirs.make("installed-terminal-evidence-limit-");
  writeJson(path.join(root, "candidate-package-identity.json"), {});
  writeJson(path.join(root, "package-hasher-contract.json"), {});
  writeJson(path.join(root, "package-heartbeat-contracts.json"), {});
  writeJson(path.join(root, "installed-terminal-contracts.json"), {});
  writeJson(path.join(root, "healthy-dependencies.json"), {});
  const bytes = randomBytes(7 * 1024 * 1024);
  fs.writeFileSync(path.join(root, "healthy-update.out"), bytes);
  fs.writeFileSync(path.join(root, "healthy-update.err"), Buffer.alloc(0));
  expect(() =>
    publishInstalledTerminalEvidence(root, {
      status: "failed",
      commands: [{ name: "healthy-update" }],
      cells: [],
    }),
  ).toThrow("Evidence export exceeds 7 MiB");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "export/manifest.json"), "utf8"));
  expect(manifest.status).toBe("failed");
  expect(manifest.error).toContain("Evidence export exceeds 7 MiB");
  expect(manifest.bytes).toBeLessThan(7 * 1024 * 1024);
  expect(fs.existsSync(path.join(root, "export/healthy-update.out.gz"))).toBe(false);
  expect(fs.readFileSync(path.join(root, "healthy-update.out")).equals(bytes)).toBe(true);
});

// Exact emitted Node script from the SRI-bound 2026.10.9 fixture.
const publishedNodeProbe = String.raw`
const selectSqliteLibrary = () => {};
let sqliteVersion = null;
let sqliteSelectionError = null;
let sqliteLibraryPath = null;
let sqliteProbe = { available: false, version: null, text: false, blob: false, json: false };
try {
  const selection = selectSqliteLibrary();
  if (selection?.path) sqliteLibraryPath = require("node:path").resolve(selection.path);
} catch (error) {
  sqliteSelectionError = error instanceof Error ? error.message : String(error);
}
if (sqliteSelectionError === null) {
  try {
    sqliteProbe = (function probeSqlite(DatabaseSync) {
	const result = {
		available: false,
		version: null,
		text: false,
		blob: false,
		json: false
	};
	let database;
	try {
		database = new DatabaseSync(":memory:");
		result.available = true;
		const version = database.prepare("SELECT sqlite_version() AS version").get()?.version;
		result.version = typeof version === "string" ? version : null;
		const text = "a\0b\0";
		const bytes = Buffer.from(text, "utf8");
		const json = JSON.stringify({ value: text });
		database.exec("CREATE TABLE probe (text_value TEXT, blob_value BLOB, json_value TEXT)");
		database.prepare("INSERT INTO probe VALUES (?, ?, ?)").run(text, bytes, json);
		const row = database.prepare("SELECT text_value, blob_value, json_value FROM probe").get();
		result.text = typeof row?.text_value === "string" && row.text_value.length === 4 && Buffer.from(row.text_value, "utf8").equals(bytes);
		result.blob = row?.blob_value instanceof Uint8Array && Buffer.from(row.blob_value).equals(bytes);
		result.json = row?.json_value === json && JSON.parse(row.json_value).value === text;
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);
	} finally {
		database?.close();
	}
	return result;
})(require("node:sqlite").DatabaseSync);
    sqliteVersion = sqliteProbe.version;
  } catch {}
}
const variables = (process.config && process.config.variables) || {};
const nodeSharedSqlite = variables.node_shared_sqlite === true || variables.node_shared_sqlite === "true";
process.stdout.write(JSON.stringify({ nodeVersion: process.versions.node, bunVersion: process.versions.bun ?? null, sqliteVersion, sqliteProbe, sqliteSelectionError, sqliteLibraryPath, nodeSharedSqlite }));
`;

it.each([false, true])(
  "qualifies only successful package-owned pre-handoff Node entries (historical=%s)",
  async (historical) => {
    const f = fixture();
    const packageRoot = path.join(f.root, "prefix/openclaw");
    const sqliteRelative = "dist/infra/sqlite-readonly-location.worker.js";
    const checkRelative = "dist/infra/update-migrated-finalize.worker.js";
    const heartbeatRelative = "dist/state/openclaw-state-lease-heartbeat.worker.js";
    const revision = historical
      ? "8b18b5578f66eab1501cba4cef2310d88bfb9a41"
      : "7ef902d3b4126b2f1f5d58aaad3d1340b1e0315d";
    for (const relative of [sqliteRelative, checkRelative, heartbeatRelative]) {
      const file = path.join(packageRoot, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        "const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close();\n",
      );
    }
    writeJson(path.join(packageRoot, "package.json"), { name: "openclaw", version: "1.0.0" });
    writeJson(path.join(packageRoot, "dist/build-info.json"), {
      version: "1.0.0",
      commit: revision,
    });
    const probe = path.join(f.root, "daemon-runtime-probe.mjs");
    const generated = await import(
      pathToFileURL(path.resolve("src/infra/daemon-runtime-probe.generated.mjs")).href
    );
    const probeSource: unknown = generated.DAEMON_RUNTIME_PROBE_SOURCE;
    assert(typeof probeSource === "string");
    if (!historical) {
      expect(createHash("sha256").update(probeSource).digest("hex")).toBe(
        "8700a6c51bb2bd0040ec85d263d81ab1fd34057fa290290d568187ed945da1dc",
      );
    }
    fs.writeFileSync(probe, probeSource);
    expect(createHash("sha256").update(publishedNodeProbe).digest("hex")).toBe(
      "954fe0502bbd8beb9de99ca78dced72c87b9a8ebd6110dd62fc25ee19eeb61ce",
    );
    const launches = [
      [path.join(packageRoot, sqliteRelative), "--openclaw-sqlite-readonly-child", "session"],
      ...(historical ? [] : [[path.join(packageRoot, checkRelative), "--check"]]),
      historical ? ["-e", publishedNodeProbe] : [probe, "node", ""],
    ];
    const snapshotEntry = path.join(f.root, "snapshot", sqliteRelative);
    fs.mkdirSync(path.dirname(snapshotEntry), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, sqliteRelative), snapshotEntry);
    const snapshotLaunch = [snapshotEntry, "--openclaw-sqlite-readonly-child", "session"];
    const preloadMarker = path.join(f.root, "closed-entry-preload-ran");
    const preload = path.join(f.root, "closed-entry-preload.cjs");
    fs.writeFileSync(
      preload,
      `require('node:fs').appendFileSync(${JSON.stringify(preloadMarker)}, 'ran');`,
    );
    const script = path.join(packageRoot, "dist/closed-parent.cjs");
    fs.writeFileSync(
      script,
      `
    const {spawn} = require('node:child_process');
    const {once} = require('node:events');
    (async () => {
      const execa = ${historical ? "undefined" : `(await import(${JSON.stringify(import.meta.resolve("execa"))})).execa`};
      let getters = 0, traps = 0, execaLaunches = 0;
      const outcomes = [];
      const unsafe = process.argv[2] === 'unsafe';
      const snapshot = process.argv[2]?.startsWith('snapshot');
      const ignoredBuffer = process.argv[2] === 'ignored-buffer';
      const inputs = snapshot ? [${JSON.stringify(snapshotLaunch)}] : unsafe ? Array(11).fill(${JSON.stringify(launches[0])}) : ignoredBuffer ? Array(3).fill(${JSON.stringify(launches[0])}) : ${JSON.stringify(launches)};
      for (const [index, input] of inputs.entries()) {
        let argv = input;
        const env = process.argv[2] === 'snapshot-observed' ? process.env : argv[1] === '--openclaw-sqlite-readonly-child' ? {} : {OPENCLAW_CLI:'1'};
        let options = {env, stdio:'ignore'};
        if (unsafe && index === 0) options = {get env(){getters++; return env;}, stdio:'ignore'};
        if (unsafe && index === 1) options.env = {get OPENCLAW_CLI(){getters++; return '1';}};
        if (unsafe && index === 2) options.env = new Proxy(env, {ownKeys(target){traps++; return Reflect.ownKeys(target);}});
        if (unsafe && index === 3) { argv = [...input]; Object.defineProperty(argv, 0, {get(){getters++; return input[0];}}); }
        if (unsafe && index === 4) argv = new Proxy(input, {get(target,key,receiver){traps++; return Reflect.get(target,key,receiver);}});
        if (unsafe && index === 5) options.shell = true;
        if (unsafe && index === 6) Object.defineProperty(Object.prototype, 'NODE_OPTIONS', {value:'--no-warnings', enumerable:true, configurable:true});
        if (unsafe && index === 7) Object.defineProperty(options, 'env', {value:env, enumerable:false});
        if (unsafe && index === 8) Object.defineProperty(options, 'env', {enumerable:true,configurable:true,get(){getters++;Object.defineProperty(options,'env',{value:env,enumerable:true,configurable:true});return {...env,NODE_OPTIONS:${JSON.stringify(`--require=${preload}`)}};}});
        if (unsafe && index === 9) {argv=[...input];Object.defineProperty(argv,0,{configurable:true,get(){getters++;Object.defineProperty(argv,0,{value:input[0],configurable:true});return ${JSON.stringify(preload)};}});}
        if (unsafe && index === 10) {options.cwd=require('node:url').pathToFileURL(${JSON.stringify(f.root)});Object.defineProperty(options.cwd,'protocol',{get(){getters++;env.NODE_OPTIONS=${JSON.stringify(`--require=${preload}`)};return 'file:';}});}
        if (ignoredBuffer && index === 0) options.maxBuffer = new Proxy([1024,1024], {get(){traps++;throw new Error('nested buffer read');},ownKeys(){traps++;throw new Error('nested buffer keys');}});
        if (ignoredBuffer && index === 1) options.maxBuffer = {get valueOf(){getters++;throw new Error('nested buffer coercion');}};
        if (ignoredBuffer && index === 2) Object.defineProperty(options,'maxBuffer',{enumerable:true,get(){getters++;return [1024,1024];}});
        if (execa && !unsafe && !snapshot && !ignoredBuffer && index > 0) {
          const result = await execa(process.execPath, argv, {...options,extendEnv:false,encoding:'buffer',maxBuffer:1024*1024});
          execaLaunches++;
          outcomes.push([result.exitCode,result.signal ?? null]);
          continue;
        }
        const child = spawn(process.execPath, argv, options);
        if (unsafe && index === 6) delete Object.prototype.NODE_OPTIONS;
        outcomes.push(await once(child, 'close'));
      }
      console.log(JSON.stringify({outcomes,getters,traps,execaLaunches}));
    })().catch(error => {console.error(error); process.exitCode = 1;});
  `,
    );
    fs.writeFileSync(
      path.join(packageRoot, "openclaw.mjs"),
      "await import('./dist/closed-parent.cjs');\n",
    );
    fs.mkdirSync(path.join(packageRoot, "node_modules"));
    const identity = readWorkerCellPackageIdentity(packageRoot);
    const inventory = path.join(f.root, "inventory.json");
    writeJson(inventory, identity);
    const contract = {
      ...readInstalledTerminalHeartbeat(packageRoot, identity),
      dependencies: readInstalledTerminalDependencyTree(path.join(packageRoot, "node_modules")),
      dependencyReferenceSha256: "1".repeat(64),
      closedEntries: readInstalledTerminalClosedEntries(packageRoot, identity, historical),
      inventory: {
        path: inventory,
        sha256: createHash("sha256").update(fs.readFileSync(inventory)).digest("hex"),
      },
    };
    expect(contract.closedEntries.map((entry) => entry.role)).toEqual(
      historical ? ["sqlite-session"] : ["sqlite-session", "finalizer-check"],
    );
    const spec = { ...f.spec, root: packageRoot, historical, heartbeatWorkers: [contract] };
    writeJson(path.join(f.root, "spec.json"), spec);
    const plain = runProcess(node, [script], process.env, 10_000);
    const observed = runProcess(node, [script], f.env, 10_000);
    expect(observed.status, observed.stderr).toBe(0);
    expect(plain.status, plain.stderr).toBe(0);
    expect(observed.stdout).toBe(plain.stdout);
    expect(JSON.parse(observed.stdout).execaLaunches).toBe(historical ? 0 : 2);
    const rows = packageRecords(f);
    expect(rows.filter((row) => row.event === "startup")).toHaveLength(1);
    const launchesObserved = rows.filter((row) => row.event === "spawn");
    expect(launchesObserved).toHaveLength(launches.length);
    expect(launchesObserved.map((row) => row.packageEntry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "sqlite-session", environmentQualified: true }),
        expect.objectContaining({
          role: historical ? "published-node-probe" : "node-runtime-probe",
          environmentQualified: true,
        }),
      ]),
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow("Missing Node child");
    const parent = rows.find((row) => row.event === "startup");
    const lastClose = rows.findLast((row) => row.event === "spawn-close");
    assert(
      parent && lastClose && typeof parent.pid === "number" && typeof lastClose.time === "string",
    );
    const parentPid = parent.pid;
    const scope = { time: (BigInt(lastClose.time) + 1n).toString(), child: 999999, databases: [] };
    writeJson(path.join(f.spec.directory, "handoff.json"), scope);
    const originalExit = rows.at(-1);
    assert(originalExit?.event === "exit");
    const withHandoff: Record<string, unknown>[] = [
      ...rows.slice(0, -1),
      { pid: parent.pid, thread: 0, event: "handoff", ...scope },
      originalExit,
    ];
    const filename = path.join(f.spec.directory, `${parent.pid}-0.jsonl`);
    const writeRows = (entries: typeof withHandoff) =>
      fs.writeFileSync(
        filename,
        entries.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
      );
    writeRows(withHandoff);
    const qualified = readInstalledTerminalEvents(f.spec.directory, spec);
    expect(qualified.filter((row) => row.event === "spawn").map((row) => row.coverage)).toEqual(
      launchesObserved.map(() => expect.objectContaining({ reason: "settled-before-handoff" })),
    );
    const firstLaunch = launches[0];
    assert(firstLaunch);
    const created = launchesObserved[0];
    assert(created && typeof created.packageEntry === "object" && created.packageEntry);
    assert(typeof created.spawnId === "number" && typeof created.child === "number");
    const spawnId = created.spawnId;
    const childPid = created.child;
    const close = rows.find(
      (row) => row.event === "spawn-close" && row.spawnId === created.spawnId,
    );
    const exit = rows.find((row) => row.event === "spawn-exit" && row.spawnId === created.spawnId);
    assert(close && exit);
    const change = (target: unknown, patch: Record<string, unknown>) =>
      withHandoff.map((row) => (row === target ? Object.assign({}, row, patch) : row));
    for (const denied of [
      withHandoff.filter((row) => row !== close),
      [...withHandoff.slice(0, -1), close, originalExit],
      change(exit, { code: 1 }),
      change(exit, { code: null, signal: "SIGTERM" }),
      change(close, { time: scope.time }),
      change(created, { argv: [...firstLaunch, "extra"] }),
      ...[
        { environmentQualified: false },
        { entrySha256: "f".repeat(64) },
        { contractRevision: "f".repeat(40) },
        { root: path.join(f.root, "foreign") },
        { rootIdentity: "1:2" },
        { inventorySha256: "f".repeat(64) },
        { dependencySha256: "f".repeat(64) },
        { dependencyReferenceSha256: "f".repeat(64) },
      ].map((patch) =>
        change(created, { packageEntry: Object.assign({}, created.packageEntry, patch) }),
      ),
    ]) {
      writeRows(denied);
      expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow();
    }
    if (!historical) {
      const probeLaunch = launchesObserved.find(
        (row) => Array.isArray(row.argv) && row.argv[0] === probe,
      );
      assert(
        probeLaunch && typeof probeLaunch.packageEntry === "object" && probeLaunch.packageEntry,
      );
      for (const patch of [{ sha256: "f".repeat(64) }, { source: `${probeSource}// changed\n` }]) {
        writeRows(
          change(probeLaunch, {
            packageEntry: Object.assign({}, probeLaunch.packageEntry, patch),
          }),
        );
        expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow(
          "Missing Node child",
        );
      }
    }
    writeRows(withHandoff.filter((row) => row !== exit));
    expect(() =>
      readInstalledTerminalEvents(f.spec.directory, {
        ...spec,
        processAbsence: [
          {
            pid: parentPid,
            thread: 0,
            spawnId,
            child: childPid,
            sourceKind: "linux-pid-absence",
            observerPid: process.pid,
            time: scope.time,
            errorCode: "ESRCH",
            ownExitCode: null,
          },
        ],
      }),
    ).toThrow();
    writeRows(withHandoff);
    if (historical) {
      expect(() =>
        readInstalledTerminalEvents(f.spec.directory, { ...spec, historical: false }),
      ).toThrow();
    }
    for (const file of fs.readdirSync(f.spec.directory)) {
      fs.unlinkSync(path.join(f.spec.directory, file));
    }
    const unsafePlain = runProcess(node, [script, "unsafe"], process.env, 10_000);
    expect(fs.readFileSync(preloadMarker, "utf8")).toBe("ranranran");
    fs.rmSync(preloadMarker);
    const unsafeObserved = runProcess(node, [script, "unsafe"], f.env, 10_000);
    expect(unsafeObserved.status, unsafeObserved.stderr).toBe(0);
    expect(unsafeObserved.stdout).toBe(unsafePlain.stdout);
    expect(fs.readFileSync(preloadMarker, "utf8")).toBe("ranranran");
    expect(
      f
        .records()
        .filter((row) => row.event === "spawn")
        .map((row) => row.packageEntry),
    ).toEqual([
      expect.objectContaining({ environmentQualified: false }),
      expect.objectContaining({ environmentQualified: false }),
      expect.objectContaining({ environmentQualified: false }),
      undefined,
      undefined,
      expect.objectContaining({ environmentQualified: false }),
      expect.objectContaining({ environmentQualified: false }),
      expect.objectContaining({ environmentQualified: false }),
      expect.objectContaining({ environmentQualified: false }),
      undefined,
      expect.objectContaining({ environmentQualified: false }),
    ]);
    expect(
      f
        .records()
        .filter((row) => row.event === "spawn")
        .slice(3, 5)
        .map((row) => row.argv),
    ).toEqual([null, null]);
    const hiddenEnvironmentChild = f.records().filter((row) => row.event === "spawn")[7];
    assert(hiddenEnvironmentChild);
    expect(f.records()).toContainEqual(
      expect.objectContaining({ event: "startup", pid: hiddenEnvironmentChild.child }),
    );
    expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow("Missing Node child");
    for (const file of fs.readdirSync(f.spec.directory)) {
      fs.unlinkSync(path.join(f.spec.directory, file));
    }
    const ignoredPlain = runProcess(node, [script, "ignored-buffer"], process.env, 10_000);
    const ignoredObserved = runProcess(node, [script, "ignored-buffer"], f.env, 10_000);
    expect(ignoredPlain.status, ignoredPlain.stderr).toBe(0);
    expect(ignoredObserved.status, ignoredObserved.stderr).toBe(0);
    expect(ignoredObserved.stdout).toBe(ignoredPlain.stdout);
    expect(JSON.parse(ignoredObserved.stdout)).toEqual({
      outcomes: [
        [0, null],
        [0, null],
        [0, null],
      ],
      getters: 1,
      traps: 0,
      execaLaunches: 0,
    });
    expect(
      f
        .records()
        .filter((row) => row.event === "spawn")
        .map((row) => row.packageEntry),
    ).toEqual([
      expect.objectContaining({ environmentQualified: true }),
      expect.objectContaining({ environmentQualified: true }),
      expect.objectContaining({ environmentQualified: false }),
    ]);
    for (const mode of ["snapshot-observed", "snapshot-unobserved"]) {
      for (const file of fs.readdirSync(f.spec.directory)) {
        fs.unlinkSync(path.join(f.spec.directory, file));
      }
      const snapshotPlain = runProcess(node, [script, mode], process.env, 10_000);
      const snapshotObserved = runProcess(node, [script, mode], f.env, 10_000);
      expect(snapshotPlain.status, snapshotPlain.stderr).toBe(0);
      expect(snapshotObserved.status, snapshotObserved.stderr).toBe(0);
      expect(snapshotObserved.stdout).toBe(snapshotPlain.stdout);
      const snapshotRows = f.records();
      const snapshotSpawn = snapshotRows.filter((row) => row.event === "spawn");
      expect(snapshotSpawn).toHaveLength(1);
      expect(snapshotSpawn[0]?.argv).toEqual(snapshotLaunch);
      expect(snapshotSpawn[0]?.packageEntry).toBeUndefined();
      expect(fs.existsSync(path.join(f.spec.directory, "observer-failed.json"))).toBe(false);
      for (const event of ["spawn-exit", "spawn-close"]) {
        expect(snapshotRows.filter((row) => row.event === event)).toEqual([
          expect.objectContaining({ spawned: true, code: 0, signal: null }),
        ]);
      }
      if (mode === "snapshot-observed") {
        expect(snapshotRows.filter((row) => row.event === "startup")).toHaveLength(2);
        expect(snapshotRows.filter((row) => row.event === "sqlite-construct")).toEqual([
          expect.objectContaining({ pid: snapshotSpawn[0]?.child, opened: true }),
        ]);
        const snapshotEvents = readInstalledTerminalEvents(f.spec.directory, spec);
        expect(snapshotEvents.find((row) => row.event === "spawn")?.coverage).toBeUndefined();
      } else {
        expect(snapshotRows.filter((row) => row.event === "startup")).toHaveLength(1);
        expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow(
          "Missing Node child",
        );
      }
    }
  },
);

it("admits package-bound heartbeat lifetimes only outside predecessor observation", () => {
  const f = fixture();
  const relativePath = "dist/state/openclaw-state-lease-heartbeat.worker.js";
  const packageRoot = path.join(f.root, "prefix/openclaw");
  const worker = path.join(packageRoot, relativePath);
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  const source = `/*${" ".repeat(70 * 1024)}*/
    const {workerData} = require('node:worker_threads');
    console.log(JSON.stringify({engine: workerData.databaseEngineSelection?.effectiveEngines.state ?? null}));
    workerData.databaseAdmissionPort.close(); workerData.lossPort.close();
    const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close();`;
  fs.writeFileSync(worker, source);
  writeJson(path.join(packageRoot, "package.json"), { name: "openclaw", version: "1.0.0" });
  writeJson(path.join(packageRoot, "dist/build-info.json"), {
    version: "1.0.0",
    commit: "a".repeat(40),
  });
  fs.writeFileSync(
    path.join(packageRoot, "openclaw.mjs"),
    "await import('./dist/heartbeat-parent.cjs');\n",
  );
  fs.mkdirSync(path.dirname(f.spec.bin), { recursive: true });
  fs.symlinkSync(path.join(packageRoot, "openclaw.mjs"), f.spec.bin);
  fs.writeFileSync(path.join(packageRoot, "dist/shared.js"), "// original shared chunk\n");
  const script = path.join(packageRoot, "dist/heartbeat-parent.cjs");
  fs.writeFileSync(
    script,
    `
    const {Worker, MessageChannel} = require('node:worker_threads');
    const channels = [new MessageChannel(), new MessageChannel()];
    const mode = process.argv[2] === 'case' ? process.argv[3] : undefined;
    const engines = Object.fromEntries(['state','agent','workboard','logbook','team-reports','quarantine','managed-update','package-activation'].map(key => [key,'sqlite']));
    const data = {
      identity: {scope:'scope', key:'key', owner:'owner-private-fixture'},
      databaseEngineSelection: {effectiveEngines:engines},
      databaseAdmissionPort:channels[0].port1, lossPort:channels[1].port1,
      path:'fixture.sqlite', expectedIdentity:'fixture-identity',
      leaseMs:1000, acquiredAt:1, heartbeatMs:100,
      processOwner: {identity:{pid:1,host:'fixture',startedAt:null,processNamespace:null,machineIdentity:null},env:{PRIVATE_FIXTURE:'not-for-receipts'}},
      shared:new SharedArrayBuffer(16), renewalProgress:new SharedArrayBuffer(8)
    };
    let reads = 0;
    let options = {
      env:{}, execArgv:!mode && process.argv[2] ? [process.argv[2],process.argv[3]] : [],
      workerData:data, transferList:[data.databaseAdmissionPort,data.lossPort]
    };
    if (mode === 'missing') delete data.databaseEngineSelection;
    if (mode === 'hidden') Object.defineProperty(data,'databaseEngineSelection',{enumerable:false});
    if (mode === 'postgres') engines.state = 'postgres';
    if (mode === 'pool') data.postgresPool = {};
    if (mode === 'nested-getter') Object.defineProperty(data.identity,'scope',{enumerable:true,get(){reads++;engines.state='postgres';return 'scope';}});
    if (mode === 'transfer-getter') Object.defineProperty(options.transferList,0,{get(){reads++;engines.state='postgres';return data.databaseAdmissionPort;}});
    if (mode === 'proxy') options = new Proxy(options,{get(target,key,receiver){reads++;return Reflect.get(target,key,receiver);}});
    if (mode === 'nested-proxy') data.identity = new Proxy(data.identity,{});
    function Alternate() {}
    Alternate.prototype = Worker.prototype;
    const constructor = mode === 'constructor' ? new Proxy(Alternate,{get(target,key,receiver){if(key==='prototype'){reads++;engines.state='postgres';}return Reflect.get(target,key,receiver);}}) : Worker;
    try {
      const worker = Reflect.construct(Worker,[require('node:path').join(__dirname,'..',${JSON.stringify(relativePath)}),options],constructor);
      console.log(JSON.stringify({reads}));
      worker.once('exit',code => {
        for (const channel of channels) channel.port2.close();
        process.exitCode = code;
      });
    } catch (error) {
      for (const channel of channels) {channel.port1.close();channel.port2.close();}
      console.log(JSON.stringify({error:error.name,reads}));
    }
  `,
  );
  const dependency = path.join(packageRoot, "node_modules/dependency/scripts/postinstall");
  fs.mkdirSync(path.dirname(dependency), { recursive: true });
  fs.writeFileSync(
    `${dependency}.js`,
    "const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close(); console.log('dependency complete');",
  );
  const sha256 = createHash("sha256").update(source).digest("hex");
  const identity = readWorkerCellPackageIdentity(packageRoot);
  const inventory = path.join(f.root, "inventory.json");
  fs.writeFileSync(inventory, JSON.stringify(identity));
  const contract = {
    ...readInstalledTerminalHeartbeat(packageRoot, identity),
    dependencies: readInstalledTerminalDependencyTree(path.join(packageRoot, "node_modules")),
    dependencyReferenceSha256: "1".repeat(64),
    inventory: {
      path: inventory,
      sha256: createHash("sha256").update(fs.readFileSync(inventory)).digest("hex"),
    },
  };
  expect(contract).toMatchObject({ relativePath, sha256, source });
  const spec = { ...f.spec, root: packageRoot, heartbeatWorkers: [contract] };
  writeJson(path.join(f.root, "spec.json"), spec);
  expect(fs.existsSync(dependency)).toBe(false);
  const lifecycle = runProcess(node, [dependency], f.env, 10_000);
  expect(lifecycle.status, lifecycle.stderr).toBe(0);
  expect(lifecycle.stdout).toBe("dependency complete\n");
  const lifecycleRows = readInstalledTerminalEvents(f.spec.directory, spec);
  expect(lifecycleRows.find((row) => row.event === "startup")).toMatchObject({ entry: dependency });
  expect(lifecycleRows.some((row) => row.event === "sqlite-construct")).toBe(true);
  expect(lifecycleRows.find((row) => row.event === "exit")).toMatchObject({ code: 0 });
  expect(lifecycleRows.some((row) => row.event === "heartbeat-package")).toBe(false);
  expect(fs.readdirSync(f.spec.directory).some((name) => name.startsWith("heartbeat-"))).toBe(
    false,
  );
  for (const file of fs.readdirSync(f.spec.directory)) {
    fs.unlinkSync(path.join(f.spec.directory, file));
  }
  const result = runProcess(node, [f.spec.bin], f.env, 10_000);
  expect(result.status, result.stderr).toBe(0);
  const observed = packageRecords(f);
  const created = observed.find((row) => row.event === "thread");
  assert(created);
  const physical = fs.lstatSync(packageRoot, { bigint: true });
  const manifest = fs.lstatSync(path.join(packageRoot, "package.json"), { bigint: true });
  const qualification = {
    qualifiedRoot: packageRoot,
    rootIdentity: `${physical.dev}:${physical.ino}`,
    manifestIdentity: `${manifest.dev}:${manifest.ino}`,
    manifestSha256: createHash("sha256")
      .update(fs.readFileSync(path.join(packageRoot, "package.json")))
      .digest("hex"),
    sha256,
    inventorySha256: contract.inventorySha256,
    sourceCommit: contract.sourceCommit,
    dependencyIdentity: contract.dependencies.identity,
    dependencySha256: contract.dependencies.sha256,
    dependencyReferenceSha256: contract.dependencyReferenceSha256,
    metadata: readInstalledTerminalMetadata(packageRoot, identity),
  };
  const packageHeartbeat = {
    root: packageRoot,
    ...qualification,
    launch: {
      environment: "empty",
      execArgv: [],
      eval: false,
      keys: ["env", "execArgv", "transferList", "workerData"],
    },
    sqliteLaunch: {
      kind: "sqlite-finite-clone-v1",
      effectiveEngines: Object.fromEntries(
        [
          "state",
          "agent",
          "workboard",
          "logbook",
          "team-reports",
          "quarantine",
          "managed-update",
          "package-activation",
        ].map((family) => [family, "sqlite"]),
      ),
    },
  };
  expect(created.packageHeartbeat).toEqual(packageHeartbeat);
  expect(JSON.stringify(created.packageHeartbeat)).not.toContain("owner-private-fixture");
  expect(JSON.stringify(created.packageHeartbeat)).not.toContain("not-for-receipts");
  expect(observed.find((row) => row.event === "heartbeat-package")).toMatchObject(qualification);
  expect(observed.filter((row) => row.event === "startup")).toHaveLength(1);
  expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow(
    "Missing worker-thread",
  );
  for (const mode of [
    "missing",
    "hidden",
    "postgres",
    "pool",
    "nested-getter",
    "transfer-getter",
    "proxy",
    "nested-proxy",
    "constructor",
  ]) {
    for (const file of fs.readdirSync(f.spec.directory)) {
      fs.unlinkSync(path.join(f.spec.directory, file));
    }
    const plain = runProcess(node, [f.spec.bin, "case", mode], {}, 10_000);
    const instrumented = runProcess(node, [f.spec.bin, "case", mode], f.env, 10_000);
    expect(instrumented.status, `${mode}: ${instrumented.stderr}`).toBe(plain.status);
    expect(instrumented.stdout, mode).toBe(plain.stdout);
    expect(instrumented.status, mode).toBe(0);
    const records = f.records();
    const launch = records.find((row) => row.event === "thread");
    expect(launch?.packageHeartbeat, mode).toBeUndefined();
    expect(fs.existsSync(path.join(f.spec.directory, "observer-failed.json")), mode).toBe(false);
    if (mode === "nested-proxy") {
      expect(launch, mode).toBeUndefined();
      expect(JSON.parse(instrumented.stdout)).toMatchObject({ error: "DataCloneError", reads: 0 });
    } else {
      expect(launch, mode).toBeDefined();
      expect(
        records.some((row) => row.event === "thread-exit"),
        mode,
      ).toBe(true);
      expect(() => readInstalledTerminalEvents(f.spec.directory, spec), mode).toThrow(
        "Missing worker-thread",
      );
      if (["nested-getter", "transfer-getter", "constructor"].includes(mode)) {
        expect(instrumented.stdout, mode).toContain('"engine":"postgres"');
      }
    }
  }
  const extraPreload = path.join(f.root, "heartbeat-preload.cjs");
  const marker = path.join(f.root, "heartbeat-preload-ran");
  fs.writeFileSync(
    extraPreload,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran');`,
  );
  for (const flag of ["--require", "--import"]) {
    for (const file of fs.readdirSync(f.spec.directory)) {
      fs.unlinkSync(path.join(f.spec.directory, file));
    }
    fs.rmSync(marker, { force: true });
    const withLoader = runProcess(node, [f.spec.bin, flag, extraPreload], f.env, 10_000);
    expect(withLoader.status, `${flag}: ${withLoader.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, "utf8"), flag).toBe("ran");
    const unqualified = f.records().find((row) => row.event === "thread");
    expect(unqualified?.packageHeartbeat, flag).toBeUndefined();
    expect(
      f.records().some((row) => row.event === "thread-exit"),
      flag,
    ).toBe(true);
    expect(() => readInstalledTerminalEvents(f.spec.directory, spec), flag).toThrow(
      "Missing worker-thread",
    );
  }
  for (const file of fs.readdirSync(f.spec.directory)) {
    fs.unlinkSync(path.join(f.spec.directory, file));
  }
  fs.unlinkSync(f.spec.bin);
  fs.symlinkSync(script, f.spec.bin);
  const wrongLauncher = runProcess(node, [f.spec.bin], f.env, 10_000);
  expect(wrongLauncher.status, wrongLauncher.stderr).toBe(0);
  expect(
    JSON.parse(fs.readFileSync(path.join(f.spec.directory, "observer-failed.json"), "utf8")).error,
  ).toContain("Installed launcher does not select the admitted package");
  fs.unlinkSync(f.spec.bin);
  fs.symlinkSync(path.join(packageRoot, "openclaw.mjs"), f.spec.bin);
  for (const [name, foreign, changed] of [
    ["foreign", true, false],
    ["shared-mismatch", false, true],
    ["dependency-mismatch", false, false],
  ] as const) {
    for (const file of fs.readdirSync(f.spec.directory)) {
      fs.unlinkSync(path.join(f.spec.directory, file));
    }
    const root = foreign
      ? path.join(f.root, name)
      : path.join(
          path.dirname(packageRoot),
          ".openclaw.update-stage-test/lib/node_modules/openclaw",
        );
    fs.cpSync(packageRoot, root, { recursive: true });
    if (changed) {
      fs.appendFileSync(path.join(root, "dist/shared.js"), "// changed\n");
    }
    if (name === "dependency-mismatch") {
      fs.appendFileSync(
        path.join(root, "node_modules/dependency/scripts/postinstall.js"),
        "// changed\n",
      );
    }
    const refused = runProcess(node, [path.join(root, "dist/heartbeat-parent.cjs")], f.env, 10_000);
    expect(refused.status, refused.stderr).toBe(0);
    expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow(
      "Observer recording failed",
    );
    const failure = JSON.parse(
      fs.readFileSync(path.join(f.spec.directory, "observer-failed.json"), "utf8"),
    );
    expect(failure.error).toContain(
      foreign
        ? "outside task custody"
        : changed
          ? "Unqualified heartbeat package root"
          : "Staged dependency tree changed",
    );
  }
  for (const name of fs.readdirSync(f.spec.directory)) {
    fs.unlinkSync(path.join(f.spec.directory, name));
  }
  const staged = path.join(
    path.dirname(packageRoot),
    ".openclaw.update-stage-rename/lib/node_modules/openclaw",
  );
  fs.cpSync(packageRoot, staged, { recursive: true });
  const stagedResult = runProcess(
    node,
    [path.join(staged, "dist/heartbeat-parent.cjs")],
    f.env,
    10_000,
  );
  expect(stagedResult.status, stagedResult.stderr).toBe(0);
  const stagedLaunches = f
    .records()
    .filter((row) => row.event === "thread" && row.pid === stagedResult.pid && row.thread === 0);
  expect(stagedLaunches).toHaveLength(1);
  const stagedBinding = stagedLaunches[0]?.packageHeartbeat;
  assert(stagedBinding && typeof stagedBinding === "object");
  expect(stagedBinding).toMatchObject({ root: staged, qualifiedRoot: staged });
  const oldRoot = path.join(f.root, "original-package");
  fs.renameSync(packageRoot, oldRoot);
  fs.renameSync(staged, packageRoot);
  const activated = runProcess(node, [f.spec.bin], f.env, 10_000);
  expect(activated.status, activated.stderr).toBe(0);
  const activatedRows = f.records();
  // Directory order is not chronology; bind the exact native parent in both orders.
  for (const rows of [activatedRows, activatedRows.toReversed()]) {
    expect(
      rows
        .filter((row) => row.event === "thread" && row.pid === activated.pid && row.thread === 0)
        .map((row) => row.packageHeartbeat),
    ).toEqual([{ ...stagedBinding, root: packageRoot }]);
  }
  expect(
    fs
      .readdirSync(f.spec.directory)
      .filter((name) => name.startsWith("heartbeat-") && name.endsWith(".json")),
  ).toHaveLength(1);
  // Restore the original package solely for the deterministic reader fixtures.
  fs.renameSync(packageRoot, staged);
  fs.renameSync(oldRoot, packageRoot);
  for (const name of fs.readdirSync(f.spec.directory)) {
    fs.unlinkSync(path.join(f.spec.directory, name));
  }
  const writeRows = (pid: number, rows: Record<string, unknown>[]) =>
    fs.writeFileSync(
      path.join(f.spec.directory, `${pid}-0.jsonl`),
      rows.map((row, sequence) => JSON.stringify({ pid, thread: 0, sequence, ...row })).join("\n") +
        "\n",
    );
  const scope = { time: "10", child: 2, databases: [] };
  writeJson(path.join(f.spec.directory, "handoff.json"), scope);
  const thread = {
    event: "thread",
    childThread: 1,
    entry: worker,
    packageHeartbeat,
    time: "2",
  };
  const exit = { event: "thread-exit", childThread: 1, code: 1, time: "3" };
  const parent = [
    { event: "startup", ppid: 999, entry: script, time: "0" },
    { event: "heartbeat-package", ...qualification, time: "1" },
    thread,
    exit,
    { event: "spawn", spawnId: 0, child: 2, nodeChild: true, time: "4" },
    { event: "handoff", ...scope },
    {
      event: "spawn-exit",
      spawnId: 0,
      child: 2,
      spawned: true,
      code: 0,
      signal: null,
      time: "28",
    },
    { event: "exit", code: 0, time: "30" },
  ];
  const candidate = [
    { event: "startup", ppid: 1, entry: "/candidate.js", time: "5" },
    { ...thread, time: "11" },
    { ...exit, time: "12" },
    { event: "exit", code: 0, time: "27" },
  ];
  writeRows(1, parent);
  writeRows(2, candidate);
  const qualified = readInstalledTerminalEvents(f.spec.directory, spec);
  expect(qualified.filter((row) => row.event === "thread").map((row) => row.coverage)).toEqual([
    {
      role: "state-lease-heartbeat",
      reason: "settled-before-handoff",
      sourceCommit: contract.sourceCommit,
      sha256,
    },
    {
      role: "state-lease-heartbeat",
      reason: "candidate-subtree",
      sourceCommit: contract.sourceCommit,
      sha256,
    },
  ]);
  for (const changed of [
    parent.map((row) =>
      row === thread
        ? { ...thread, packageHeartbeat: { ...packageHeartbeat, sqliteLaunch: undefined } }
        : row,
    ),
    parent.map((row) =>
      row === thread
        ? {
            ...thread,
            packageHeartbeat: {
              ...packageHeartbeat,
              sqliteLaunch: {
                ...packageHeartbeat.sqliteLaunch,
                effectiveEngines: {
                  ...packageHeartbeat.sqliteLaunch.effectiveEngines,
                  state: "postgres",
                },
              },
            },
          }
        : row,
    ),
    parent.map((row) =>
      row === thread
        ? { ...thread, packageHeartbeat: { ...packageHeartbeat, launch: undefined } }
        : row,
    ),
    parent.map((row) =>
      row === thread
        ? {
            ...thread,
            packageHeartbeat: {
              ...packageHeartbeat,
              launch: { ...packageHeartbeat.launch, execArgv: ["--require=extra.cjs"] },
            },
          }
        : row,
    ),
    parent.map((row) => (row === exit ? { ...exit, time: "11" } : row)),
    parent.map((row) =>
      row === thread ? { ...thread, time: "11" } : row === exit ? { ...exit, time: "12" } : row,
    ),
    parent.map((row) =>
      row === thread
        ? { ...thread, packageHeartbeat: { ...packageHeartbeat, sha256: "b".repeat(64) } }
        : row,
    ),
    parent.map((row) =>
      row === thread ? { ...thread, entry: path.join(f.root, "unbound/worker.js") } : row,
    ),
    parent.map((row) =>
      row === thread
        ? {
            ...thread,
            entry: path.join(f.root, "foreign", relativePath),
            packageHeartbeat: { ...packageHeartbeat, root: path.join(f.root, "foreign") },
          }
        : row,
    ),
    parent.map((row) =>
      row === thread
        ? { ...thread, packageHeartbeat: { ...packageHeartbeat, rootIdentity: "0:1" } }
        : row,
    ),
  ]) {
    writeRows(1, changed);
    expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow(
      "Missing worker-thread",
    );
  }
  writeRows(
    1,
    parent.filter((row) => row !== exit),
  );
  expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow(
    "no unique native exit",
  );
  writeRows(1, parent);
  expect(() =>
    readInstalledTerminalEvents(f.spec.directory, {
      ...spec,
      heartbeatWorkers: [{ ...contract, sha256: "b".repeat(64) }],
    }),
  ).toThrow("Missing worker-thread");
  fs.appendFileSync(worker, "\n// changed installed entry\n");
  expect(() =>
    readInstalledTerminalHeartbeat(packageRoot, {
      buildInfo: { commit: contract.sourceCommit },
      files: { [relativePath]: { sha256 } },
    }),
  ).toThrow();
});

it("bounds full traces by the handoff while retaining every native lifetime and descendant", () => {
  const f = fixture();
  const writeRows = (pid: number, rows: Record<string, unknown>[]) =>
    fs.writeFileSync(
      path.join(f.spec.directory, `${pid}-0.jsonl`),
      rows.map((row, sequence) => JSON.stringify({ pid, thread: 0, sequence, ...row })).join("\n") +
        "\n",
    );
  const startup = (ppid: number, time: string) => ({
    event: "startup",
    ppid,
    time,
    entry: "/fixture.js",
  });
  const scope = { time: "10", child: 2, databases: [] };
  writeJson(path.join(f.spec.directory, "handoff.json"), scope);
  const parent: Record<string, unknown>[] = [startup(999, "1")];
  for (let pid = 3; pid < 263; pid++) {
    const sync = pid % 2 === 0;
    parent.push({
      event: "spawn",
      api: sync ? "spawnSync" : undefined,
      spawnId: pid,
      child: pid,
      nodeChild: true,
      time: "2",
    });
    // An interrupted operation is outside this proof only with a complete,
    // source-bound native lifetime strictly before the handoff.
    writeRows(pid, [
      startup(1, "3"),
      { event: "sqlite-intent", operation: 0, time: "4" },
      { event: "exit", code: 0, time: "5" },
    ]);
    parent.push({
      event: sync ? "spawn-sync-return" : "spawn-exit",
      spawnId: pid,
      child: pid,
      spawned: true,
      code: 0,
      signal: null,
      errorCode: sync ? null : undefined,
      time: "6",
    });
  }
  parent.push(
    { event: "spawn", spawnId: 2, child: 2, nodeChild: true, time: "7" },
    { event: "handoff", ...scope },
    {
      event: "spawn-exit",
      spawnId: 2,
      child: 2,
      spawned: true,
      code: 0,
      signal: null,
      time: "20",
    },
    { event: "exit", code: 0, time: "30" },
  );
  writeRows(1, parent);
  writeRows(2, [startup(1, "8"), { event: "exit", code: 0, time: "19" }]);
  expect(
    readInstalledTerminalEvents(f.spec.directory).filter((row) => row.event === "startup"),
  ).toHaveLength(262);
  const moved = parent.map((row) =>
    row.event === "spawn-exit" && row.child === 3 ? { ...row, time: "15" } : row,
  );
  writeRows(1, moved);
  writeRows(3, [
    startup(1, "3"),
    { event: "sqlite-intent", operation: 0, time: "4" },
    { event: "exit", code: 0, time: "14" },
  ]);
  expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("observation interrupted");
  writeRows(3, [
    startup(1, "3"),
    { event: "sqlite-intent", operation: 0, time: "4" },
    { event: "exit", code: 0, time: "5" },
  ]);
  writeRows(
    1,
    parent.filter((row) => !(row.event === "spawn-exit" && row.child === 3)),
  );
  expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("no unique native exit");
  writeRows(1, parent);
  writeRows(3, [
    startup(1, "3"),
    { event: "spawn", spawnId: 0, child: 263, nodeChild: true, time: "4" },
    { event: "exit", code: 0, time: "5" },
  ]);
  writeRows(263, [startup(3, "4"), { event: "exit", code: 0, time: "14" }]);
  expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("no unique native exit");
  fs.unlinkSync(path.join(f.spec.directory, "263-0.jsonl"));
  writeRows(3, [
    startup(1, "3"),
    { event: "sqlite-intent", operation: 0, time: "4" },
    { event: "stdout", bytes: "", time: "4" },
    { event: "stdout", bytes: "IA==", time: "4" },
    { event: "exit", code: 0, time: "5" },
  ]);
  const root = path.dirname(f.spec.directory);
  fs.renameSync(f.spec.directory, path.join(root, "healthy"));
  writeJson(path.join(root, "candidate-package-identity.json"), {});
  writeJson(path.join(root, "package-hasher-contract.json"), {});
  writeJson(path.join(root, "package-heartbeat-contracts.json"), {});
  writeJson(path.join(root, "installed-terminal-contracts.json"), {});
  writeJson(path.join(root, "healthy-dependencies.json"), {});
  writeJson(path.join(root, "healthy/observer.json"), {});
  publishInstalledTerminalEvidence(root, {
    status: "passed",
    commands: [],
    cells: [{ name: "healthy" }],
  });
  const lifetimes = gunzipSync(
    fs.readFileSync(path.join(root, "export/healthy-lifetimes.jsonl.gz")),
  )
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lifetimes).toHaveLength(263);
  expect(lifetimes.pop()).toMatchObject({
    diagnosticOnly: true,
    qualification: "unaccepted",
    status: "complete",
    files: 262,
    projectedFiles: 262,
    omittedFiles: 0,
  });
  expect(
    lifetimes.every(
      (row) =>
        row.sha256.length === 64 &&
        row.recordsComplete === true &&
        row.qualification === "unaccepted" &&
        row.events.some((event: { event: string }) => event.event === "startup"),
    ),
  ).toBe(true);
  expect(
    lifetimes
      .find((row) => row.name === "3-0.jsonl")
      .events.filter((row: { event: string }) => row.event === "stdout"),
  ).toMatchObject([{ bytes: "" }, { bytes: "IA==" }]);
  expect(
    lifetimes
      .find((row) => row.name === "1-0.jsonl")
      .events.filter((row: { event: string }) => row.event === "spawn-sync-return"),
  ).toHaveLength(130);
  const trace = gunzipSync(fs.readFileSync(path.join(root, "export/healthy-observer.jsonl.gz")));
  expect(trace.equals(fs.readFileSync(path.join(root, "healthy/1-0.jsonl")))).toBe(true);
  const absence: InstalledTerminalProcessAbsence = {
    pid: 1,
    thread: 0,
    spawnId: 2,
    child: 2,
    observerPid: 999,
    sourceKind: "linux-pid-absence",
    time: "31",
    errorCode: "ESRCH",
    ownExitCode: null,
  };
  const healthy = path.join(root, "healthy");
  const parentLog = path.join(healthy, "1-0.jsonl");
  const originalParent = fs.readFileSync(parentLog);
  fs.writeFileSync(
    parentLog,
    parent
      .filter((row) => !(row.event === "spawn-exit" && row.child === 2))
      .map((row, sequence) => JSON.stringify({ pid: 1, thread: 0, sequence, ...row }))
      .join("\n") + "\n",
  );
  writeJson(path.join(healthy, "observer.json"), { processAbsence: [absence] });
  fs.rmSync(path.join(root, "export"), { recursive: true });
  publishInstalledTerminalEvidence(root, {
    status: "passed",
    commands: [],
    cells: [{ name: "healthy" }],
  });
  const fullCandidate = gunzipSync(
    fs.readFileSync(path.join(root, "export/healthy-observer.jsonl.gz")),
  );
  expect(
    fullCandidate.equals(
      Buffer.concat([fs.readFileSync(parentLog), fs.readFileSync(path.join(healthy, "2-0.jsonl"))]),
    ),
  ).toBe(true);
  fs.writeFileSync(parentLog, originalParent);
  writeJson(path.join(healthy, "observer.json"), {});
  for (const pid of [2, 3]) {
    const childLog = path.join(healthy, `${pid}-0.jsonl`);
    const originalChild = fs.readFileSync(childLog);
    fs.writeFileSync(
      childLog,
      readJsonLines<Record<string, unknown>>(childLog)
        .filter((row) => row.event !== "exit")
        .map((row, sequence) => JSON.stringify({ ...row, sequence }))
        .join("\n") + "\n",
    );
    fs.rmSync(path.join(root, "export"), { recursive: true });
    publishInstalledTerminalEvidence(root, {
      status: "passed",
      commands: [],
      cells: [{ name: "healthy" }],
    });
    expect(
      gunzipSync(fs.readFileSync(path.join(root, "export/healthy-observer.jsonl.gz"))),
    ).toEqual(Buffer.concat([originalParent, fs.readFileSync(childLog)]));
    fs.writeFileSync(childLog, originalChild);
  }
  // Every coverage refusal must leave the launch facts that explain it.
  const entry = "file:///installed/retained-runtime/worker.js";
  for (const failure of ["missing-worker", "duplicate-exit", "truncated", "projection-cap"]) {
    fs.rmSync(path.join(root, "export"), { recursive: true });
    const thread = { event: "thread", childThread: 1, entry, time: "21" };
    const exit = { event: "thread-exit", childThread: 1, code: 0, time: "22" };
    const records = [
      ...parent.slice(0, -1),
      thread,
      exit,
      ...(failure === "duplicate-exit" ? [exit] : []),
      parent.at(-1),
    ];
    const log = path.join(root, "healthy/1-0.jsonl");
    fs.writeFileSync(
      log,
      records
        .map((row, sequence) => JSON.stringify({ pid: 1, thread: 0, sequence, ...row }))
        .join("\n") + "\n",
    );
    if (failure === "truncated") {
      fs.appendFileSync(log, '{"event":');
    }
    if (failure === "projection-cap") {
      for (const name of fs
        .readdirSync(path.join(root, "healthy"))
        .filter((entryName) => entryName.endsWith(".jsonl"))) {
        const file = path.join(root, "healthy", name);
        const rows = readJsonLines<Record<string, unknown>>(file);
        fs.writeFileSync(
          file,
          rows
            .map((row) =>
              JSON.stringify(row.event === "startup" ? { ...row, entry: "x".repeat(20_000) } : row),
            )
            .join("\n") + "\n",
        );
      }
    }
    const expected = ["missing-worker", "projection-cap"].includes(failure)
      ? "Missing worker-thread"
      : failure === "duplicate-exit"
        ? "no unique native exit"
        : "truncated";
    expect(() =>
      publishInstalledTerminalEvidence(root, {
        status: "failed",
        commands: [],
        cells: [{ name: "healthy" }],
      }),
    ).toThrow(expected);
    const retained = gunzipSync(
      fs.readFileSync(path.join(root, "export/healthy-lifetimes.jsonl.gz")),
    )
      .toString()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const creator = retained.find((row) => row.name === "1-0.jsonl");
    expect(creator).toMatchObject({
      diagnosticOnly: true,
      qualification: "unaccepted",
      recordsComplete: failure !== "truncated",
    });
    expect(creator.sha256).toBe(createHash("sha256").update(fs.readFileSync(log)).digest("hex"));
    expect(creator.events.find((row: { event: string }) => row.event === "thread")).toMatchObject({
      pid: 1,
      thread: 0,
      childThread: 1,
      entry,
    });
    expect(
      creator.events.filter((row: { event: string }) => row.event === "thread-exit"),
    ).toHaveLength(failure === "duplicate-exit" ? 2 : 1);
    const footer = retained.at(-1);
    if (failure === "projection-cap") {
      expect(footer).toMatchObject({ status: "incomplete", files: 262 });
      expect(footer.error).toContain("exceeds 4 MiB");
      expect(footer.projectedFiles).toBeLessThan(262);
      expect(footer.omittedFiles).toBe(262 - footer.projectedFiles);
    } else {
      expect(footer).toMatchObject({
        status: failure === "truncated" ? "incomplete" : "complete",
        files: 262,
        projectedFiles: 262,
        omittedFiles: 0,
      });
    }
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "export/manifest.json"), "utf8")),
    ).toMatchObject({ status: "failed" });
    expect(fs.existsSync(path.join(root, "export/healthy-observer.jsonl.gz"))).toBe(false);
  }
});

it("keeps a small failed receipt when the complete isolate census exceeds its bound", () => {
  const root = dirs.make("installed-terminal-census-limit-");
  const cells = ["healthy", "late-failure", "historical-control"].map((name) => ({ name }));
  writeJson(path.join(root, "candidate-package-identity.json"), {});
  writeJson(path.join(root, "package-hasher-contract.json"), {});
  writeJson(path.join(root, "package-heartbeat-contracts.json"), {});
  writeJson(path.join(root, "installed-terminal-contracts.json"), {});
  writeJson(path.join(root, "healthy-dependencies.json"), {});
  for (const { name } of cells) {
    writeJson(path.join(root, `${name}-dependencies.json`), {});
    fs.mkdirSync(path.join(root, name));
    for (let index = 0; index < 192; index++) {
      fs.writeFileSync(path.join(root, name, `${"1".repeat(200)}${index}-0.jsonl`), "");
    }
  }
  expect(() =>
    publishInstalledTerminalEvidence(root, { status: "failed", commands: [], cells }),
  ).toThrow("Evidence manifest exceeds 128 KiB");
  const bytes = fs.readFileSync(path.join(root, "export/manifest.json"));
  expect(bytes.length).toBeLessThan(128 * 1024);
  expect(JSON.parse(bytes.toString())).toMatchObject({
    status: "failed",
    files: [],
    fileCount: 13,
    censusOmitted: true,
    error: "Error: Evidence manifest exceeds 128 KiB",
    errorTruncated: false,
  });
});

it.each(["installed", "published"] as const)(
  "binds %s hasher launch options before native construction",
  (kind) => {
    const f = fixture();
    const worker = path.join(f.root, "hasher.mjs");
    const source =
      kind === "installed"
        ? `${stripTypeScriptTypes(fs.readFileSync("src/infra/package-update-integrity-hasher.worker.ts", "utf8"))}\nexport {};\n`
        : (JSON.parse(
            fs.readFileSync("test/fixtures/installed-terminal-historical-helpers.json", "utf8"),
          ).packageHasher as string);
    fs.writeFileSync(worker, source);
    const spec = {
      ...f.spec,
      historical: kind === "published",
      hashWorker: { path: worker, sha256: createHash("sha256").update(source).digest("hex") },
    };
    writeJson(path.join(f.root, "spec.json"), spec);
    const script = path.join(f.root, "parent.cjs");
    const preload = path.join(f.root, "extra.cjs");
    const marker = path.join(f.root, "preload-ran");
    fs.writeFileSync(
      preload,
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    for (const variant of [
      "plain",
      "hidden",
      "require",
      "import",
      "clone-mutation",
      "getter",
      "proxy",
      "inherit-env",
      "inherit-argv",
      "inherited-argv",
      "environment",
      "unknown",
      ...(kind === "installed"
        ? ["plain-url", "url-mutation", "url-subclass", "url-clone-change", "search-params-hook"]
        : []),
    ]) {
      fs.writeFileSync(
        script,
        `
      const assert = require('node:assert/strict');
      const {Worker} = require('node:worker_threads');
      const {once} = require('node:events');
      (async () => {
        const variant = ${JSON.stringify(variant)};
        const preload = ${JSON.stringify(preload)};
        const cancel = new Int32Array(new SharedArrayBuffer(4));
        let reads = 0, cloneReads = 0;
        let input = {env:{}, execArgv:[], eval:${kind === "published"}, workerData:{cancel}};
        if (variant === 'hidden') {
          Object.defineProperty(input, 'env', {value:{}, enumerable:false});
          Object.defineProperty(input, 'execArgv', {value:[], enumerable:false});
        }
        if (variant === 'require' || variant === 'import') input.execArgv = ['--'+variant, preload];
        if (variant === 'environment') input.env = {NODE_OPTIONS:'--require='+preload};
        if (variant === 'clone-mutation') {
          input.execArgv = ['--require', preload];
          input.workerData = {get cancel(){cloneReads++; input.execArgv=[]; return cancel;}};
        }
        if (variant === 'getter') Object.defineProperty(input, 'execArgv', {get(){reads++; return [];}});
        if (variant === 'proxy') input = new Proxy(input, {get(target,key,receiver){reads++; return Reflect.get(target,key,receiver);}});
        if (variant === 'inherit-env') delete input.env;
        if (variant === 'inherit-argv') delete input.execArgv;
        if (variant === 'unknown') input.name = 'unqualified';
        if (variant === 'inherited-argv') Object.defineProperty(Object.prototype, 'argv', {
          configurable:true, value:[{toString(){reads++; input.execArgv=['--require',preload]; return 'extra';}}]
        });
        let entry = ${kind === "installed" ? JSON.stringify(worker) : JSON.stringify(source)};
        const sentinel = new Error('native search params hook');
        if (['plain-url','url-mutation','url-subclass','url-clone-change','search-params-hook'].includes(variant)) {
          const url = require('node:url').pathToFileURL(entry);
          const protocol = () => {reads++; input.execArgv=['--require',preload]; return 'file:';};
          entry = variant === 'url-subclass' ? new (class extends URL {get protocol(){return protocol();}})(url.href) : url;
          if (variant === 'url-mutation') Object.defineProperty(entry, 'protocol', {get:protocol});
          if (variant === 'search-params-hook') {
            const params = entry.searchParams;
            params.set('dirty', '1');
            Object.defineProperty(params, 'size', {get(){reads++; throw sentinel;}});
          }
          if (variant === 'url-clone-change') input.workerData = {get cancel(){cloneReads++; entry.pathname='/unused-after-native-capture'; return cancel;}};
          else if (variant !== 'plain-url') input.workerData = {get cancel(){cloneReads++; input.execArgv=[]; return cancel;}};
        }
        let child;
        try { child = new Worker(entry, input); }
        catch (error) {
          if (variant !== 'search-params-hook') throw error;
          assert.equal(error, sentinel);
          console.log(JSON.stringify({reads,cloneReads,caught:true}));
          return;
        }
        finally { if (variant === 'inherited-argv') delete Object.prototype.argv; }
        child.once('online', () => child.postMessage('close'));
        const [code] = await once(child, 'exit');
        assert.equal(code, 0);
        console.log(JSON.stringify({reads,cloneReads}));
      })().catch(error => {console.error(error); process.exitCode=1;});
    `,
      );
      fs.rmSync(marker, { force: true });
      const plain = runProcess(
        node,
        [script],
        { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
        10_000,
      );
      expect(plain.status, `${kind}/${variant}: ${plain.stderr}`).toBe(0);
      const plainMarker = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
      fs.rmSync(marker, { force: true });
      for (const file of fs.readdirSync(f.spec.directory)) {
        fs.unlinkSync(path.join(f.spec.directory, file));
      }
      const observed = runProcess(node, [script], f.env, 10_000);
      expect(observed.status, `${kind}/${variant}: ${observed.stderr}`).toBe(plain.status);
      expect(observed.stdout, `${kind}/${variant}: getter parity`).toBe(plain.stdout);
      expect(
        fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "",
        `${kind}/${variant}: preload parity`,
      ).toBe(plainMarker);
      if (
        [
          "require",
          "clone-mutation",
          "inherited-argv",
          "environment",
          "url-mutation",
          "url-subclass",
        ].includes(variant) ||
        (kind === "installed" && variant === "import")
      ) {
        expect(plainMarker, `${kind}/${variant}: real preload ran`).toBe("ran");
      }
      if (variant === "clone-mutation") {
        expect(JSON.parse(observed.stdout)).toMatchObject({ cloneReads: 1 });
      }
      const rows = f.records();
      if (variant === "search-params-hook") {
        expect(JSON.parse(observed.stdout)).toEqual({ reads: 1, cloneReads: 0, caught: true });
        expect(rows.filter((row) => row.event === "thread")).toHaveLength(0);
        continue;
      }
      const created = rows.find((row) => row.event === "thread");
      assert(created);
      const admitted = ["plain", "hidden", "plain-url", "url-clone-change"].includes(variant);
      if (admitted) {
        expect(created.packageHasher, `${kind}/${variant}`).toMatchObject({
          kind: kind === "installed" ? "installed-file" : "published-inline",
          launch: { environment: "empty", execArgv: [], eval: kind === "published" },
        });
      } else {
        expect(created.packageHasher, `${kind}/${variant}`).toBeUndefined();
      }
      expect(
        rows.filter((row) => row.event === "thread-exit"),
        `${kind}/${variant}`,
      ).toHaveLength(1);
      if (
        admitted ||
        rows.some((row) => row.event === "startup" && row.thread === created.childThread)
      ) {
        expect(
          () => readInstalledTerminalEvents(f.spec.directory, spec),
          `${kind}/${variant}`,
        ).not.toThrow();
      } else {
        expect(
          () => readInstalledTerminalEvents(f.spec.directory, spec),
          `${kind}/${variant}`,
        ).toThrow("Missing worker-thread");
      }
    }
  },
);

it.each([true, false])(
  "changes only the launcher after a drained successful worker: %s",
  (successful) => {
    const f = fixture();
    const worker = path.join(f.root, "update-migrated-finalize.worker.mjs");
    const parent = path.join(f.root, "parent.cjs");
    fs.writeFileSync(
      worker,
      `
    import fs from 'node:fs';
    if (process.argv[2]) { process.stdin.resume(); } else {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    const response = { result: { root: request.params.result.root, runId: 'run', status: ${JSON.stringify(successful ? "ok" : "error")} }, terminalRunId: 'run', exitCode: ${successful ? 0 : 1} };
    fs.writeFileSync(request.resultPath, JSON.stringify(response));
    process.stdout.write(JSON.stringify(response.result));
    }
  `,
    );
    fs.writeFileSync(
      parent,
      `
    const assert = require('node:assert/strict');
    const fs = require('node:fs'); const fsp = require('node:fs/promises');
    const { DatabaseSync } = require('node:sqlite');
    const { spawn } = require('node:child_process'); const { once } = require('node:events');
    const spec = ${JSON.stringify(f.spec)};
    fs.mkdirSync(require('node:path').dirname(spec.bin)); fs.symlinkSync('../entry.mjs', spec.bin);
    const identity = file => { const s = fs.lstatSync(file, { bigint: true }); return s.dev + ':' + s.ino; };
    const original = identity(spec.bin);
    const state = new DatabaseSync(spec.stateDatabase);
    state.exec("CREATE TABLE update_runs(run_id TEXT, status TEXT, phase TEXT); INSERT INTO update_runs VALUES('run','succeeded','finished')"); state.close();
    const agent = new DatabaseSync(spec.agentDatabase);
    agent.exec("PRAGMA user_version=39; CREATE TABLE schema_meta(meta_key TEXT,schema_version INTEGER); INSERT INTO schema_meta VALUES('primary',39); CREATE TABLE cache_entries(scope TEXT,key TEXT,value_json TEXT)");
    agent.prepare('INSERT INTO cache_entries VALUES(?,?,?)').run('installed-terminal','retained','"preserve-me"'); agent.close();
    const journal = new DatabaseSync(spec.journal);
    journal.exec('CREATE TABLE package_activation(slot INTEGER,phase TEXT,descriptor_json TEXT,publications_json TEXT)');
    journal.prepare('INSERT INTO package_activation VALUES(1,?,?,?)').run('publication-complete', JSON.stringify({authority:{installKey:spec.root},binDir:require('node:path').dirname(spec.bin)}), JSON.stringify([{name:'openclaw',identity:original}])); journal.close();
    (async () => {
      for (const mode of ['--check','--doctor','--post-core','--settle-plugin-cohort','--commit-plugin-cohort']) {
        const probe = spawn(process.execPath, [${JSON.stringify(worker)}, mode], { stdio: ['pipe','ignore','ignore'] });
        const exited = once(probe, 'close'); probe.stdin.end('{}'); assert.equal((await exited)[0], 0);
      }
      const resultPath = spec.root + '/result.json';
      const child = spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: ['pipe','pipe','pipe'] });
      child.stdout.resume(); child.stderr.resume();
      const closed = once(child, 'close');
      const request = JSON.stringify({ resultPath, params: { opts:{run:{runId:'run'}},rollbackBlockedReason:'state-migrated-no-rollback',schemaVersions:[{path:spec.stateDatabase,userVersion:39},{path:spec.agentDatabase,userVersion:25,contentVersion:25}],result:{root:spec.root} } });
      child.stdin.write(request.slice(0, 10)); child.stdin.end(request.slice(10));
      assert.equal((await closed)[0], 0);
      ${successful ? "await fsp.readFile(resultPath, 'utf8'); assert.notEqual(identity(spec.bin), original); assert.equal(identity(spec.escrow), original); assert.equal(fs.readlinkSync(spec.bin), fs.readlinkSync(spec.escrow));" : "assert.equal(JSON.parse(await fsp.readFile(resultPath, 'utf8')).result.status, 'error'); assert.equal(identity(spec.bin), original); assert(!fs.existsSync(spec.escrow));"}
      ${
        successful
          ? `
      // More unrelated completed pairs than the recorder event budget must not
      // crowd out the canonical-store proof or change the actual native calls.
      for (let i=0;i<4200;i++) { const db=new DatabaseSync(spec.journal); db.close(); }
      const alias=spec.root+'/agent-alias.sqlite'; fs.linkSync(spec.agentDatabase,alias);
      const deferred=new DatabaseSync(require('node:url').pathToFileURL(alias),{open:false}); deferred.open(); deferred.close();
      const nested=new DatabaseSync(spec.journal,{get open(){process.stdout.write('nested-event'); return true;}}); nested.close();
      const changed=spec.root+'/changed.sqlite'; fs.writeFileSync(changed,'');
      const raced=new DatabaseSync(changed,{get open(){fs.unlinkSync(changed); fs.linkSync(spec.agentDatabase,changed); return true;}}); raced.close();
      `
          : ""
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    );
    const result = runProcess(node, [parent], f.env, 10_000);
    expect(result.status, result.stderr).toBe(0);
    const rows = f.records();
    const closed = rows.findIndex((row) => row.event === "worker-closed");
    expect(closed).toBeGreaterThanOrEqual(0);
    if (successful) {
      const passed = rows.findIndex((row) => row.event === "candidate-success");
      const intent = rows.findIndex((row) => row.event === "launcher-intent");
      const replaced = rows.findIndex((row) => row.event === "launcher-replaced");
      expect(passed).toBeGreaterThan(closed);
      expect(intent).toBeGreaterThan(passed);
      expect(replaced).toBeGreaterThan(intent);
      const handoff = rows.find((row) => row.event === "handoff")!;
      const lateJournal = rows.filter(
        (row) =>
          row.event === "sqlite-construct" &&
          row.location === f.spec.journal &&
          BigInt(String(row.time)) > BigInt(String(handoff.time)),
      );
      expect(lateJournal).toHaveLength(1); // Reentrant stdout keeps its ordinary pair.
      expect(
        rows.find(
          (row) =>
            row.event === "sqlite-open" && row.location === path.join(f.root, "agent-alias.sqlite"),
        ),
      ).toMatchObject({ opened: true });
      expect(
        rows.find(
          (row) =>
            row.event === "sqlite-construct" &&
            row.location === path.join(f.root, "changed.sqlite"),
        ),
      ).toMatchObject({ opened: true });
      expect(() => readInstalledTerminalEvents(f.spec.directory)).not.toThrow();
      // Event corruption cannot erase an independently acknowledged fault.
      const parentLog = fs.readdirSync(f.spec.directory).find((name) => name.endsWith("-0.jsonl"));
      expect(parentLog).toBeDefined();
      fs.appendFileSync(path.join(f.spec.directory, parentLog!), "{truncated");
      expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("truncated");
      expect(restoreInstalledTerminalLauncher(f.spec).status).toBe("restored");
      expect(fs.existsSync(f.spec.escrow)).toBe(false);
    } else {
      expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow(
        "coverage is unqualified",
      );
      expect(
        rows.some((row) => row.event === "candidate-success" || row.event === "launcher-intent"),
      ).toBe(false);
    }
  },
);

it.each([false, true])(
  "requires matched native operations when a worker is terminated: %s",
  (inflight) => {
    const f = fixture();
    const script = path.join(f.root, "terminate.cjs");
    const workerPath = path.join(f.root, "terminate-worker.cjs");
    const source = `
    const {parentPort} = require('node:worker_threads');
    ${inflight ? "new (require('node:sqlite').DatabaseSync)(':memory:', {get open(){parentPort.postMessage('ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); return true;}});" : "const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close(); parentPort.postMessage('ready');"}
    setInterval(()=>{}, 1000);
  `;
    // Packaged native workers use a file entry. Classic CJS eval bypasses
    // Node's ESM --import preload and cannot exercise this observer boundary.
    fs.writeFileSync(workerPath, source);
    fs.writeFileSync(
      script,
      `
    const {Worker} = require('node:worker_threads');
    const worker = new Worker(${JSON.stringify(workerPath)}, {execArgv:[]});
    worker.once('message', () => worker.terminate());
  `,
    );
    const result = runProcess(node, [script], f.env, 10_000);
    expect(result.status, result.stderr).toBe(0);
    const rows = f.records();
    const threads = rows.filter((row) => row.event === "thread");
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    assert(thread, "Missing Worker creation event");
    expect(rows.filter((row) => row.event === "startup")).toHaveLength(2);
    expect(
      rows.find(
        (row) =>
          row.event === "startup" && row.pid === thread.pid && row.thread === thread.childThread,
      ),
    ).toMatchObject({ entry: workerPath });
    if (inflight) {
      expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow(
        "observation interrupted",
      );
    } else {
      expect(() => readInstalledTerminalEvents(f.spec.directory)).not.toThrow();
      // Native termination can omit a process exit record. Its joined thread
      // must still fail proof if only the per-isolate failure receipt survived.
      expect(fs.existsSync(path.join(f.spec.directory, "observer-failed.json"))).toBe(false);
      assert(typeof thread.pid === "number");
      assert(typeof thread.childThread === "number");
      writeJson(path.join(f.spec.directory, `${thread.pid}-${thread.childThread}.failure.json`), {
        status: "unqualified",
        pid: thread.pid,
        thread: thread.childThread,
        error: "Observer sink failed before the shared marker was written",
      });
      expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow(
        "coverage is unqualified",
      );
    }
  },
);

it("holds an unknown replacement and restores only a recorded or absent replacement", () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.spec.bin));
  fs.symlinkSync("../entry.mjs", f.spec.bin);
  const identity = (file: string) => {
    const stat = fs.lstatSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  const intent = {
    bin: f.spec.bin,
    escrow: f.spec.escrow,
    identity: identity(f.spec.bin),
    link: "../entry.mjs",
    row: {},
  };
  writeJson(path.join(f.spec.directory, "launcher-intent.json"), intent);
  fs.renameSync(f.spec.bin, f.spec.escrow);
  fs.symlinkSync(intent.link, f.spec.bin);
  expect(() => restoreInstalledTerminalLauncher(f.spec)).toThrow(
    "Unacknowledged replacement retained",
  );
  expect(identity(f.spec.escrow)).toBe(intent.identity);
  // Simulate the acknowledged boundary immediately after rename, before symlink.
  fs.unlinkSync(f.spec.bin);
  expect(restoreInstalledTerminalLauncher(f.spec).status).toBe("restored");
  expect(identity(f.spec.bin)).toBe(intent.identity);
});

it("admits only the bound builtin hasher with a joined native thread", () => {
  const f = fixture();
  const relative = "dist/infra/package-update-integrity-hasher.worker.js";
  const worker = path.join(f.root, relative);
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(path.join(f.root, "package.json"), '{"type":"module"}');
  const source = `${stripTypeScriptTypes(
    fs.readFileSync("src/infra/package-update-integrity-hasher.worker.ts", "utf8"),
  )}\nexport {};\n`;
  fs.writeFileSync(worker, source);
  const identity = {
    files: { [relative]: { sha256: createHash("sha256").update(source).digest("hex") } },
  };
  const contract = readInstalledTerminalHasher(f.root, identity);
  const spec = { ...f.spec, hashWorker: { path: contract.path, sha256: contract.sha256 } };
  writeJson(path.join(f.root, "spec.json"), spec);
  const script = path.join(f.root, "hasher.cjs");
  fs.writeFileSync(
    script,
    `
    const {Worker} = require('node:worker_threads');
    const worker = new Worker(${JSON.stringify(worker)}, {
      env: {}, execArgv: [], workerData: {cancel:new Int32Array(new SharedArrayBuffer(4))}
    });
    worker.once('online', () => worker.postMessage('close'));
  `,
  );
  const result = runProcess(node, [script], f.env, 10_000);
  expect(result.status, result.stderr).toBe(0);
  const rows = readInstalledTerminalEvents(f.spec.directory, spec);
  expect(rows.filter((row) => row.event === "startup")).toHaveLength(1);
  expect(rows.find((row) => row.event === "thread")).toMatchObject({
    packageHasher: { kind: "installed-file", sha256: contract.sha256 },
  });
  expect(() => readInstalledTerminalEvents(f.spec.directory)).toThrow("Missing worker-thread");
  expect(() =>
    readInstalledTerminalEvents(f.spec.directory, {
      ...spec,
      hashWorker: { ...spec.hashWorker, sha256: "0".repeat(64) },
    }),
  ).toThrow("Missing worker-thread");
  const log = path.join(
    f.spec.directory,
    fs.readdirSync(f.spec.directory).find((name) => name.endsWith("-0.jsonl"))!,
  );
  const original = fs.readFileSync(log, "utf8");
  const rewrite = (events: Record<string, unknown>[]) =>
    fs.writeFileSync(
      log,
      events.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
    );
  rewrite(rows.filter((row) => row.event !== "thread-exit"));
  expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow(
    "no unique native exit",
  );
  const exit = rows.find((row) => row.event === "exit")!;
  rewrite(
    rows.map((row) =>
      row.event === "thread-exit"
        ? Object.assign({}, row, { time: String(BigInt(String(exit.time)) + 1n) })
        : row,
    ),
  );
  expect(() => readInstalledTerminalEvents(f.spec.directory, spec)).toThrow(
    "outside parent custody",
  );
  fs.writeFileSync(log, original);
  for (const edge of [
    'import "node:sqlite";',
    "export { createHash };",
    'export * from "node:fs";',
  ]) {
    fs.writeFileSync(worker, source.replace(/\nexport \{\};\n$/u, `\n${edge}\n`));
    const changed = {
      files: {
        [relative]: { sha256: createHash("sha256").update(fs.readFileSync(worker)).digest("hex") },
      },
    };
    let rejected: { source: string; sha256: string } | undefined;
    expect(() =>
      readInstalledTerminalHasher(f.root, changed, (observedContract) => {
        rejected = observedContract;
      }),
    ).toThrow("unqualified emitted edge");
    expect(rejected?.source).toBe(fs.readFileSync(worker, "utf8"));
    expect(rejected?.sha256).toBe(changed.files[relative].sha256);
  }
});

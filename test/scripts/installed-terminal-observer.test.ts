import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import {
  captureInstalledTerminalProcessAbsence,
  installedTerminalDescendants,
  type InstalledTerminalProcessAbsence,
  publishInstalledTerminalEvidence,
  readInstalledTerminalEvents,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-observer.mjs";
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
  for (const mode of ["encoding", "getter-throw", "argv-accessor", "argv-proxy", "no-preload"]) {
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
    const threw = mode === "encoding" || mode === "getter-throw";
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

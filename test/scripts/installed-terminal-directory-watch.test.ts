import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readInstalledTerminalDependencyTree,
  readInstalledTerminalMetadata,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-contracts.mjs";
import {
  type InstalledTerminalProcessAbsence,
  readInstalledTerminalEvents,
  readInstalledTerminalHeartbeat,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-terminal-observer.mjs";
import { readWorkerCellPackageIdentity } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { execNodeEvalSync, resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJsonLines, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

// The captured Linux package, SIGKILL lifecycle, and physical modes are platform-specific.
const it = test.skipIf(process.platform !== "linux");
const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const observer = path.resolve("scripts/e2e/lib/upgrade-survivor/installed-terminal-observer.mjs");
const require = createRequire(import.meta.url);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const helper = "dist/infra/directory-watch-host.worker.js";
const captured: {
  sourceCommit: string;
  closureSha256: string;
  files: Record<string, { source: string; sha256: string }>;
} = JSON.parse(fs.readFileSync("test/fixtures/installed-terminal-directory-watch.json", "utf8"));
type Row = Record<string, unknown>;

function fixture() {
  const base = fs.realpathSync(dirs.make("installed-watch-"));
  // VERSION's two ancestor candidates must stay inside the fixture, away from
  // the runner's package.json; package admission must still check both.
  const root = path.join(base, "prefix/openclaw");
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, entry] of Object.entries(captured.files)) {
    expect(hash(entry.source)).toBe(entry.sha256);
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), entry.source);
  }
  const dependency = path.resolve(path.dirname(require.resolve("@openclaw/fs-safe/json")), "..");
  fs.mkdirSync(path.join(root, "node_modules/@openclaw"), { recursive: true });
  fs.cpSync(dependency, path.join(root, "node_modules/@openclaw/fs-safe"), { recursive: true });
  writeJson(path.join(root, "package.json"), {
    name: "openclaw",
    type: "module",
    version: "0.0.0",
  });
  writeJson(path.join(root, "dist/build-info.json"), {
    version: "0.0.0",
    commit: captured.sourceCommit,
  });
  fs.mkdirSync(path.join(root, "dist/state"));
  fs.writeFileSync(
    path.join(root, "dist/state/openclaw-state-lease-heartbeat.worker.js"),
    "export {};\n",
  );
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n");
  const entry = path.join(root, "dist/watch-owner.mjs");
  const specPath = path.join(base, "spec.json");
  const resultPath = path.join(base, "result.json");
  fs.writeFileSync(
    entry,
    `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import {fileURLToPath, pathToFileURL} from "node:url";
    import {once} from "node:events";
    import {spawn} from "node:child_process";
    const mode = process.argv[2] ?? "joined";
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const watched = ${JSON.stringify(base)};
    let reads = 0;
    async function watch() {
      const env = {...process.env, NODE_OPTIONS:undefined};
      let options = {env, detached:true, stdio:["pipe","pipe","ignore"]};
      let args = [path.join(root, ${JSON.stringify(helper)}), String(process.pid)];
      if(mode === "inherited-env") options.env = Object.assign(Object.create({UNRELATED:"value"}), env);
      if(mode === "env-getter") Object.defineProperty(options, "env", {enumerable:true, get(){reads++;return env;}});
      if(mode === "extra-argument") args = ["--no-warnings", ...args];
      if(mode === "cache") options.env.NODE_COMPILE_CACHE = watched;
      if(mode === "inherited-coverage") {
        process.env.NODE_V8_COVERAGE = path.join(watched,"coverage");
        delete env.NODE_V8_COVERAGE;
      }
      if(mode === "env-equals") {
        const preload = path.join(watched,"probe.cjs");
        fs.writeFileSync(preload,
          "require('node:fs').writeFileSync(" + JSON.stringify(path.join(watched,"preload-ran")) + ",'ran');");
        options.env["NODE_OPTIONS=--require"] = preload;
      }
      if(mode === "permission") {
        const {captureDirectoryWatchLaunch} = await import(${JSON.stringify(new URL("../../scripts/e2e/lib/upgrade-survivor/installed-terminal-directory-watch.mjs", import.meta.url).href)});
        assert.equal(captureDirectoryWatchLaunch(process.execPath,
          {argv:args,options},{environmentQualified:true}),undefined);
      }
      const child = spawn(process.execPath, args, options);
      // Native errors settle registration, but only close proves the child joined.
      const closed = new Promise(resolve => child.once("close",(code,signal)=>resolve([code,signal])));
      const registered = Promise.race([
        once(child.stdout,"data"),
        new Promise((_,reject) => {
          child.once("error",reject);
          child.stdin.once("error",reject);
        }),
        closed.then(([code,signal]) => {throw new Error("watch closed before registration: "+code+"/"+signal);}),
      ]);
      let outcome;
      try {
        child.stdin.write(JSON.stringify({id:1,path:watched}) + "\\n");
        const [bytes] = await registered;
        assert.equal(JSON.parse(bytes.toString().trim()).event, "change");
        fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({pid:child.pid,reads}));
        if(mode === "creator-exit") process.exit(0);
        if(mode === "live-absence") {
          const {captureInstalledTerminalProcessAbsence} = await import(${JSON.stringify(observer)});
          fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
            pid:child.pid, receipts:captureInstalledTerminalProcessAbsence(${JSON.stringify(path.join(base, "events"))})
          }));
        }
      } finally {
        child.stdin.end();
        outcome = await closed;
      }
      const [code, signal] = outcome;
      assert.equal(code,null); assert.equal(signal,"SIGKILL");
    }
    if(mode.startsWith("retained") || mode === "unregistered") {
      const {withRetainedUpdateRuntime} = await import(${JSON.stringify(new URL("../../src/infra/update-retained-runtime.ts", import.meta.url).href)});
      const {captureRuntimeWorkerSource} = await import(${JSON.stringify(new URL("../../src/infra/runtime-worker-generation.ts", import.meta.url).href)});
      let projected;
      await withRetainedUpdateRuntime(import.meta.url, async (retain) => {
        await retain({mutationRoots:[root], timeoutMs:10000, assertCurrent(){}});
         projected = fileURLToPath(captureRuntimeWorkerSource(new URL(import.meta.url)).moduleUrl);
        assert.notEqual(projected, fileURLToPath(import.meta.url));
        // Observe prepared-runtime custody while its real registration is active.
        // Source compiler setup is outside this helper-lifetime fixture.
        process.env.NODE_OPTIONS = ${JSON.stringify(`--import=${observer}`)};
        process.env.OPENCLAW_INSTALLED_TERMINAL_OBSERVER = ${JSON.stringify(specPath)};
        await import(${JSON.stringify(observer)});
         if(mode.startsWith("retained")) {
           const key = Symbol.for("openclaw.retainedUpdateRuntimes");
           const descriptor = Object.getOwnPropertyDescriptor(globalThis,key);
           const active = descriptor.value;
           let reads = 0;
           try {
             if(mode === "retained-getter") Object.defineProperty(globalThis,key,{
               configurable:true,get(){reads++;return active;}
             });
             if(mode === "retained-proxy") Object.defineProperty(globalThis,key,{
               ...descriptor,value:new Proxy(active,{get(){reads++;throw new Error("registry trap");}})
             });
             const child = spawn(process.execPath, [projected,"joined"], {stdio:"inherit",env:{...process.env}});
             assert.equal((await once(child,"close"))[0],0);
           } finally {
             Object.defineProperty(globalThis,key,descriptor);
           }
           assert.equal(reads,0,"observer invoked registry accessors");
        }
      });
      // Same real copied bytes after the product owner releases its registration.
      if(mode === "unregistered") {
         const child = spawn(process.execPath, [projected,"joined"], {stdio:"inherit",env:{...process.env}});
        assert.equal((await once(child,"close"))[0],0);
      }
    } else {
      await watch();
    }
  `,
  );
  const bindInventory = () => {
    const identity = readWorkerCellPackageIdentity(root);
    readInstalledTerminalMetadata(root, identity);
    const inventory = path.join(base, "inventory.json");
    writeJson(inventory, identity);
    return {
      ...readInstalledTerminalHeartbeat(root, identity),
      inventory: { path: inventory, sha256: hash(fs.readFileSync(inventory)) },
      dependencies: readInstalledTerminalDependencyTree(path.join(root, "node_modules")),
      dependencyReferenceSha256: "1".repeat(64),
    };
  };
  const directory = path.join(base, "events");
  fs.mkdirSync(directory);
  const spec = {
    root,
    directory,
    bin: path.join(base, "bin/openclaw"),
    stateDatabase: path.join(base, "state/openclaw.sqlite"),
    agentDatabase: path.join(base, "agent/openclaw-agent.sqlite"),
    journal: path.join(base, "control/journal.sqlite"),
    escrow: path.join(base, "escrow"),
    heartbeatWorkers: [bindInventory()],
  };
  writeJson(specPath, spec);
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${observer}`,
    OPENCLAW_INSTALLED_TERMINAL_OBSERVER: specPath,
    NODE_V8_COVERAGE: undefined,
    NODE_COMPILE_CACHE: undefined,
    OPENCLAW_LOG_LEVEL: "silent",
    TMPDIR: base,
    HOME: base,
    OPENCLAW_STATE_DIR: path.join(base, "state"),
  };
  return {
    base,
    root,
    entry,
    directory,
    spec,
    env,
    resultPath,
    rebind() {
      spec.heartbeatWorkers = [bindInventory()];
      writeJson(specPath, spec);
    },
  };
}

function run(f: ReturnType<typeof fixture>, mode = "joined") {
  const retained = mode.startsWith("retained") || mode === "unregistered";
  return runProcess(
    node,
    [
      ...(retained ? ["--import", import.meta.resolve("tsx")] : []),
      ...(mode === "permission"
        ? [
            "--permission",
            "--allow-fs-read=*",
            "--allow-fs-write=*",
            "--allow-child-process",
            "--allow-worker",
          ]
        : []),
      f.entry,
      mode,
    ],
    retained ? { ...f.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" } : f.env,
    retained ? 20_000 : 10_000,
  );
}

function records(f: ReturnType<typeof fixture>) {
  const failure = path.join(f.directory, "observer-failed.json");
  if (fs.existsSync(failure)) {
    assert.fail(fs.readFileSync(failure, "utf8"));
  }
  return fs
    .readdirSync(f.directory)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readJsonLines<Row>(path.join(f.directory, name)));
}

function rewrite(file: string, rows: Row[]) {
  fs.writeFileSync(
    file,
    rows.map((row, sequence) => JSON.stringify({ ...row, sequence })).join("\n") + "\n",
  );
}

function absence(directory: string): InstalledTerminalProcessAbsence[] {
  return JSON.parse(
    execNodeEvalSync(
      `import {captureInstalledTerminalProcessAbsence} from ${JSON.stringify(observer)};
     console.log(JSON.stringify(captureInstalledTerminalProcessAbsence(${JSON.stringify(directory)})));`,
      {
        env: { ...process.env, NODE_OPTIONS: "", OPENCLAW_INSTALLED_TERMINAL_OBSERVER: "" },
        timeout: 10_000,
      },
    ),
  );
}

it("admits the real sanitized helper only as a closed native lifetime", () => {
  const f = fixture();
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  records(f);
  const { pid } = JSON.parse(fs.readFileSync(f.resultPath, "utf8"));
  const rows = readInstalledTerminalEvents(f.directory, f.spec);
  expect(rows.filter((row) => row.event === "startup" && row.pid === pid)).toEqual([]);
  expect(rows.find((row) => row.event === "spawn" && row.child === pid)).toMatchObject({
    coverage: {
      role: "directory-watch",
      reason: "closed-helper-lifetime",
      sha256: captured.closureSha256,
    },
  });
  expect(rows.find((row) => row.event === "spawn-exit" && row.child === pid)).toMatchObject({
    code: null,
    signal: "SIGKILL",
    spawned: true,
  });
  const created = rows.find((row) => row.event === "spawn" && row.child === pid);
  assert(created && typeof created.pid === "number" && typeof created.thread === "number");
  const filename = path.join(f.directory, `${created.pid}-${created.thread}.jsonl`);
  const original = readJsonLines<Row>(filename);
  for (const changed of [
    { ...created, command: path.join(f.base, "foreign-node") },
    { ...created, argv: [path.join(f.root, helper), String(created.pid + 1)] },
    { ...created, argv: [path.join(f.root, "foreign-worker.js"), String(created.pid)] },
  ]) {
    rewrite(
      filename,
      original.map((row) => (row.event === "spawn" && row.child === pid ? changed : row)),
    );
    expect(() => readInstalledTerminalEvents(f.directory, f.spec)).toThrow();
  }
  rewrite(filename, original);
});

it("admits post-reap absence of the real watch after its creator exits without close", async () => {
  const f = fixture();
  const result = run(f, "creator-exit");
  expect(result.status, result.stderr).toBe(0);
  const { pid } = JSON.parse(fs.readFileSync(f.resultPath, "utf8"));
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
  expect(records(f).filter((row) => row.event === "startup" && row.pid === pid)).toEqual([]);
  expect(records(f).filter((row) => row.event === "spawn-exit" && row.child === pid)).toEqual([]);
  expect(() => readInstalledTerminalEvents(f.directory, f.spec)).toThrow("no unique native exit");
  const processAbsence = absence(f.directory);
  expect(processAbsence).toHaveLength(1);
  expect(processAbsence[0]).toMatchObject({ child: pid, errorCode: "ESRCH", ownExitCode: null });
  expect(
    readInstalledTerminalEvents(f.directory, { ...f.spec, processAbsence }).find(
      (row) => row.event === "spawn" && row.child === pid,
    ),
  ).toMatchObject({
    coverage: { reason: "closed-helper-lifetime" },
    lifetimeBound: processAbsence[0],
  });
  for (const errorCode of [null, "EPERM"]) {
    expect(() =>
      readInstalledTerminalEvents(f.directory, {
        ...f.spec,
        processAbsence: processAbsence.map((receipt) => Object.assign({}, receipt, { errorCode })),
      }),
    ).toThrow("strict kernel absence");
  }
});

it.each([
  "inherited-env",
  "env-getter",
  "env-equals",
  "extra-argument",
  "cache",
  "inherited-coverage",
])("preserves native behavior without granting helper coverage for %s", (mode) => {
  const f = fixture();
  const result = run(f, mode);
  expect(result.status, result.stderr).toBe(0);
  const created = records(f).find((row) => row.event === "spawn");
  assert(created && typeof created.child === "number");
  expect(created.directoryWatch).toBeUndefined();
  expect(() => readInstalledTerminalEvents(f.directory, f.spec)).toThrow(
    "Missing Node child preload",
  );
  if (mode === "env-getter") {
    expect(JSON.parse(fs.readFileSync(f.resultPath, "utf8")).reads).toBe(1);
  }
  if (mode === "env-equals") {
    expect(fs.readFileSync(path.join(f.base, "preload-ran"), "utf8")).toBe("ran");
  }
});

it("preserves native completion while refusing permission-mode observer coverage", () => {
  const f = fixture();
  const result = run(f, "permission");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(f.resultPath, "utf8")).pid).toBeTypeOf("number");
  expect(result.stderr).toContain("[installed-terminal-observer] preload failed:");
  expect(result.stderr).toContain("fchmod API is disabled when Permission Model is enabled.");
  expect(records(f)).toEqual([]);
  const files = fs.readdirSync(f.directory).filter((file) => file.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  expect(fs.readFileSync(path.join(f.directory, files[0]!))).toHaveLength(0);
  expect(() => readInstalledTerminalEvents(f.directory, f.spec)).toThrow(
    "Observer record was truncated",
  );
});

it.each(["host", "parent", "resolver", "dependency", "scope", "symlink"])(
  "rejects changed physical %s bytes while preserving the native launch",
  (mode) => {
    const f = fixture();
    const target = path.join(
      f.root,
      mode === "host" || mode === "symlink"
        ? helper
        : mode === "parent"
          ? "dist/infra/directory-watch-parent.worker.js"
          : mode === "resolver"
            ? "dist/runtime-process-url-CL3_jEBq.mjs"
            : "node_modules/@openclaw/fs-safe/dist/json.js",
    );
    if (mode === "scope") {
      writeJson(path.join(f.root, "dist/infra/package.json"), { type: "module" });
    } else if (mode === "symlink") {
      const linked = target.replace(/\.js$/u, ".real.js");
      fs.renameSync(target, linked);
      fs.symlinkSync(linked, target);
    } else {
      fs.appendFileSync(target, "\n// changed physical bytes\n");
    }
    // Admit the new inventory independently. The fixed helper contract, not a
    // stale first-main package receipt, must reject these changed runtime bytes.
    f.rebind();
    const result = run(f);
    expect(result.status, result.stderr).toBe(0);
    const failure = fs.readFileSync(path.join(f.directory, "observer-failed.json"), "utf8");
    expect(JSON.parse(failure), failure).toMatchObject({ event: "directory-watch-custody" });
    expect(() => readInstalledTerminalEvents(f.directory, f.spec)).toThrow(
      "Observer recording failed",
    );
  },
);

it("does not turn a real live helper observation into an absence proof", () => {
  const f = fixture();
  const result = run(f, "live-absence");
  expect(result.status, result.stderr).toBe(0);
  const { pid, receipts } = JSON.parse(fs.readFileSync(f.resultPath, "utf8"));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ child: pid, errorCode: null });
  const created = records(f).find((row) => row.event === "spawn" && row.child === pid);
  assert(created && typeof created.pid === "number" && typeof created.thread === "number");
  const filename = path.join(f.directory, `${created.pid}-${created.thread}.jsonl`);
  rewrite(
    filename,
    readJsonLines<Row>(filename).filter(
      (row) => !["spawn-exit", "spawn-close"].includes(String(row.event)) || row.child !== pid,
    ),
  );
  expect(() =>
    readInstalledTerminalEvents(f.directory, { ...f.spec, processAbsence: receipts }),
  ).toThrow("strict kernel absence");
});

it("admits the copied helper's lifetime under prepared retained-runtime custody", () => {
  const f = fixture();
  const result = run(f, "retained");
  expect(result.status, result.stderr).toBe(0);
  const observed = records(f);
  let rows: Row[];
  try {
    rows = readInstalledTerminalEvents(f.directory, f.spec);
  } catch (error) {
    // Preserve original native ancestry before fixture cleanup; diagnostic
    // output grants no admission.
    const lifecycle = JSON.stringify({
      rows: observed.filter((row) =>
        [
          "startup",
          "thread",
          "thread-exit",
          "spawn",
          "spawn-exit",
          "spawn-close",
          "exit",
          "handoff",
        ].includes(String(row.event)),
      ),
    });
    try {
      process.stderr.write(
        `[retained-runtime-lifecycle] ${
          Buffer.byteLength(lifecycle) <= 128 * 1024
            ? lifecycle
            : JSON.stringify({ error: "Lifecycle diagnostic exceeded 128 KiB" })
        }\n`,
      );
    } catch {}
    throw error;
  }
  const creator = rows.find((row) => row.event === "spawn" && row.retainedRuntime);
  assert(
    creator &&
      typeof creator.child === "number" &&
      typeof creator.pid === "number" &&
      typeof creator.thread === "number",
  );
  expect(rows.find((row) => row.pid === creator.child && row.event === "spawn")).toMatchObject({
    coverage: { role: "directory-watch", reason: "closed-helper-lifetime" },
  });
  const filename = path.join(f.directory, `${creator.pid}-${creator.thread}.jsonl`);
  const original = readJsonLines<Row>(filename);
  const retained = creator.retainedRuntime as Record<string, unknown>;
  for (const changed of [
    { ...retained, rootIdentity: "0:0" },
    { ...retained, directory: path.join(f.base, "unregistered-copy") },
    { ...retained, entry: path.join(f.root, "dist/watch-owner.mjs") },
    { ...retained, capturedAt: creator.time },
  ]) {
    rewrite(
      filename,
      original.map((row) =>
        row.spawnId === creator.spawnId && row.event === "spawn"
          ? Object.assign({}, row, { retainedRuntime: changed })
          : row,
      ),
    );
    expect(() => readInstalledTerminalEvents(f.directory, f.spec)).toThrow();
  }
  rewrite(filename, original);
  const childFile = path.join(f.directory, `${creator.child}-0.jsonl`);
  const childRows = readJsonLines<Row>(childFile);
  rewrite(
    childFile,
    childRows.map((row) => (row.event === "startup" ? Object.assign({}, row, { ppid: -1 }) : row)),
  );
  expect(() => readInstalledTerminalEvents(f.directory, f.spec)).toThrow();
});

it.each(["unregistered", "retained-getter", "retained-proxy"])(
  "requires inert active producer registration for %s",
  (mode) => {
    const f = fixture();
    const result = run(f, mode);
    expect(result.status, result.stderr).toBe(0);
    expect(records(f).some((row) => row.retainedRuntime)).toBe(false);
    expect(() => readInstalledTerminalEvents(f.directory, f.spec)).toThrow(
      "no registered retained owner",
    );
  },
);

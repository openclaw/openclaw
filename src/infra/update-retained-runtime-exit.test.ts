import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let base: string;
let root: string;

it.each([false, true])(
  "keeps cold workers runnable and restores the invoking directory when available (removed=%s)",
  async (removed) => {
    const install = path.join(tempDirs.make("openclaw-retained-cwd-"), "install");
    await fs.cp(root, install, { recursive: true });
    const launch = path.join(install, "invocation");
    await fs.mkdir(launch);
    const result = spawnNodeEvalSync(
      `import assert from "node:assert/strict";
       import fs from "node:fs";
       import path from "node:path";
       import { pathToFileURL } from "node:url";
       import { Worker } from "node:worker_threads";
       import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
       import { resolveUserPath } from ${JSON.stringify(new URL("./home-dir.ts", import.meta.url).href)};
       import { resolveSessionStorePathCore } from ${JSON.stringify(new URL("../config/sessions/paths.ts", import.meta.url).href)};
       const install = ${JSON.stringify(install)};
       const launch = ${JSON.stringify(launch)};
       process.chdir(launch);
       const original = process.cwd();
       const agentPath = resolveUserPath("../operator-agent");
       const sessionPath = resolveSessionStorePathCore("../sessions.json", { agentId: "main" });
       const value = await withRetainedUpdateRuntime(pathToFileURL(path.join(install, "dist/updater.mjs")).href, async (retain) => {
         await retain({ mutationRoots: [install], timeoutMs: 30000, assertCurrent() {} });
         if (${removed}) fs.rmdirSync(launch);
         assert.equal(resolveUserPath("../operator-agent"), agentPath);
         assert.equal(resolveSessionStorePathCore("../sessions.json", { agentId: "main" }), sessionPath);
         const worker = new Worker("require('node:worker_threads').parentPort.postMessage(process.cwd())", { eval: true, execArgv: [] });
         let workerCwd;
         await new Promise((resolve, reject) => {
           worker.once("message", (cwd) => { workerCwd = cwd; });
           worker.once("error", reject);
           worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error("worker exit " + code)));
         });
         assert.equal(fs.statSync(workerCwd).isDirectory(), true);
         return "settled";
       });
       assert.equal(value, "settled");
       if (${removed}) {
         assert.equal(fs.existsSync(launch), false);
         assert.notEqual(process.cwd(), original);
         assert.equal(fs.statSync(process.cwd()).isDirectory(), true);
       } else {
         assert.equal(process.cwd(), original);
       }
       console.log("cold worker and cwd custody verified");`,
      {
        imports: [import.meta.resolve("tsx")],
        input: "",
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: base,
          TMPDIR: base,
          OPENCLAW_STATE_DIR: path.join(base, "state"),
          OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
          XDG_CACHE_HOME: path.join(base, "cache"),
          OPENCLAW_LOG_LEVEL: "silent",
        },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    expect(result.stdout).toContain("cold worker and cwd custody verified");
  },
);

beforeAll(async () => {
  base = tempDirs.make("openclaw-retained-runtime-exit-");
  root = path.join(base, "openclaw");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
  await fs.writeFile(path.join(root, "dist/updater.mjs"), "export {};\n");
  await fs.writeFile(
    path.join(root, "dist/store.mjs"),
    `import { DatabaseSync } from "node:sqlite";
     import { BroadcastChannel } from "node:worker_threads";
     export function createSqliteWorkerBackend(input, { databasePath }) {
       const db = new DatabaseSync(databasePath);
       db.exec("CREATE TABLE IF NOT EXISTS entries (value TEXT)");
       db.exec("PRAGMA busy_timeout = 10000");
       const channel = new BroadcastChannel(input.channel);
       const released = Promise.withResolvers();
       channel.onmessage = ({ data }) => {
         if (data === "release-native-close") released.resolve();
       };
       return {
         execute(command) {
           channel.postMessage("write-started");
           db.prepare("INSERT INTO entries VALUES (?)").run(command.input);
         },
         async close() {
           channel.postMessage("native-close-started");
           if (input.delayClose) await released.promise;
           db.close();
           channel.close();
           if (input.failClose) throw new Error("fixture native close failed");
         }
       };
     }`,
  );
});

it.skipIf(process.platform === "win32").each([
  { scenario: "native-close", code: 0 },
  { scenario: "already-closing", code: 1 },
  { scenario: "accepted-write", code: 0 },
  { scenario: "failed-settlement", code: 1 },
  { scenario: "thread-termination", code: 0 },
  { scenario: "failed-close-thread-termination", code: 0 },
])(
  "joins $scenario through natural exit after accepted work settles",
  async ({ scenario, code }) => {
    const databasePath = path.join(base, `${scenario}.sqlite`);
    const reportedCode = scenario === "failed-settlement" ? 0 : code;
    const result = spawnNodeEvalSync(
      `import assert from "node:assert/strict";
     import path from "node:path";
     import { DatabaseSync } from "node:sqlite";
     import { mock } from "node:test";
     import { pathToFileURL } from "node:url";
     import { BroadcastChannel, Worker } from "node:worker_threads";
     import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
     import { captureRuntimeWorkerSource } from ${JSON.stringify(new URL("./runtime-worker-generation.ts", import.meta.url).href)};
     import { openSqliteWorkerStore, runSqliteWorkerStoreOperation } from ${JSON.stringify(new URL("./sqlite-worker-store.ts", import.meta.url).href)};
     import { exitCliAfterOutput, runCliWithExitFinalization, watchCliExitAfterOutput } from ${JSON.stringify(new URL("../cli/one-shot-exit.ts", import.meta.url).href)};
     import { defaultRuntime } from ${JSON.stringify(new URL("../runtime.ts", import.meta.url).href)};
     const root = ${JSON.stringify(root)};
     const scenario = ${JSON.stringify(scenario)};
     const databasePath = ${JSON.stringify(databasePath)};
     const channel = new BroadcastChannel(databasePath);
     const nativeClose = Promise.withResolvers();
     const nativeWrite = Promise.withResolvers();
     const terminationStarted = Promise.withResolvers();
     const releaseTermination = Promise.withResolvers();
     let finalized = false;
     let backgroundClose;
     channel.onmessage = ({ data }) => {
       if (data === "native-close-started") nativeClose.resolve();
       if (data === "write-started") nativeWrite.resolve();
     };
     await runCliWithExitFinalization({
       run: () => withRetainedUpdateRuntime(pathToFileURL(path.join(root, "dist/updater.mjs")).href, async (retain) => {
         await retain({ mutationRoots: [root], timeoutMs: 30000, assertCurrent() {} });
         const source = captureRuntimeWorkerSource(pathToFileURL(path.join(root, "dist/store.mjs")));
         const threadStall = scenario.includes("thread-termination");
         const store = await openSqliteWorkerStore({ ...source, databasePath,
           input: { channel: databasePath, delayClose: !threadStall, failClose: scenario.startsWith("failed-close") } });
         mock.timers.enable({ apis: ["setTimeout"] });
         if (threadStall) {
           const terminate = Worker.prototype.terminate;
           mock.method(Worker.prototype, "terminate", async function () {
             terminationStarted.resolve();
             await releaseTermination.promise;
             const status = await terminate.call(this);
             process.stdout.write("thread termination joined\\n");
             return status;
           });
         }
         if (scenario === "accepted-write") {
           const blocker = new DatabaseSync(databasePath);
           blocker.exec("BEGIN IMMEDIATE");
           const writing = runSqliteWorkerStoreOperation(store, async (scope) => {
             await scope.execute({ type: "append", input: "accepted write survived" });
           });
           await nativeWrite.promise;
           watchCliExitAfterOutput(() => process.stdout.write("output watchdog fired\\n"));
           setImmediate(async () => {
             mock.timers.tick(10000);
             await new Promise(setImmediate);
             process.stdout.write("accepted write still joined\\n");
             blocker.exec("ROLLBACK");
             blocker.close();
             await writing;
           });
         } else {
           await store.execute({ type: "append", input: "accepted write survived" });
         }
         if (scenario === "already-closing") {
           backgroundClose = store.close().catch(() => undefined);
           await nativeClose.promise;
         }
         if (scenario.startsWith("failed-close")) {
           backgroundClose = store.close().catch(() => undefined);
           await terminationStarted.promise;
         }
         if (scenario === "failed-settlement") {
           source.runtimeGeneration.retain({}, async () => { throw new Error("fixture settlement failed"); });
         }
         void (threadStall ? terminationStarted.promise : nativeClose.promise).then(() => setImmediate(async () => {
           process.stdout.write(threadStall ? "thread termination delayed\\n" : "native close delayed\\n");
           mock.timers.tick(10000);
           await new Promise(setImmediate);
           assert.equal(finalized, false, "grace expiry must not finalize a live worker");
           process.stdout.write("native retirement still joined\\n");
           releaseTermination.resolve();
           channel.postMessage("release-native-close");
         }));
         process.stdout.write("update result: ${reportedCode}\\n");
         exitCliAfterOutput(defaultRuntime, ${reportedCode});
       }),
       onError(error) { process.stderr.write("Settlement error: " + String(error)); process.exitCode = 1; },
       async finalize() { finalized = true; await backgroundClose; },
     });
     channel.close();
     mock.restoreAll();
     process.stdout.write("natural finalization completed\\n");`,
      {
        imports: [import.meta.resolve("tsx")],
        input: "",
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: base,
          TMPDIR: base,
          OPENCLAW_STATE_DIR: path.join(base, "state"),
          OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
          XDG_CACHE_HOME: path.join(base, "cache"),
          OPENCLAW_LOG_LEVEL: "warn",
        },
      },
    );
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(code);
    expect(result.signal, result.stderr).toBeNull();
    expect(result.stdout).toContain(`update result: ${reportedCode}`);
    expect(result.stdout).toContain("native retirement still joined");
    expect(result.stdout).toContain("natural finalization completed");
    expect(result.stderr).toContain("termination is still pending after settlement");
    if (scenario !== "failed-settlement") {
      expect(result.stdout).toContain(
        scenario.includes("thread-termination")
          ? "thread termination delayed"
          : "native close delayed",
      );
      expect(result.stderr).toContain(
        scenario.startsWith("failed-close")
          ? "termination failed after settlement"
          : "worker generation settled; cleanup deferred",
      );
    } else {
      expect(result.stderr).toContain("workers did not settle");
      expect(result.stderr).not.toContain("worker generation settled; cleanup deferred");
    }
    if (scenario.includes("thread-termination")) {
      expect(result.stdout).toContain("thread termination joined");
    }
    if (scenario === "accepted-write") {
      expect(result.stdout).toContain("output watchdog fired");
      expect(result.stdout).toContain("accepted write still joined");
    }
    const rows = spawnNodeEvalSync(
      `import { DatabaseSync } from "node:sqlite";
     const db = new DatabaseSync(${JSON.stringify(databasePath)});
     console.log(JSON.stringify(db.prepare("SELECT value FROM entries").all()));
     db.close();`,
    );
    expect(rows.status, rows.stderr).toBe(0);
    expect(JSON.parse(rows.stdout)).toEqual([{ value: "accepted write survived" }]);
    expect(
      (await fs.readdir(base)).filter((name) => name.startsWith("openclaw-update-runtime-")),
    ).toHaveLength(1);
  },
);

afterEach(async () => {
  for (const name of await fs.readdir(base)) {
    if (name.startsWith("openclaw-update-runtime-")) {
      await fs.rm(path.join(base, name), { recursive: true, force: true });
    }
  }
});

// Real process exits prove resource settlement precedes deferred artifact custody.
it.skipIf(process.platform === "win32").each([
  { exit: "SIGTERM", code: 143 },
  { exit: "SIGINT", code: 130 },
  { exit: "failure-report", code: 1 },
])(
  "settles workers and records deferred runtime cleanup before $exit exits",
  async ({ exit, code }) => {
    const databasePath = path.join(base, `${exit}.sqlite`);
    const result = spawnNodeEvalSync(
      `import fs from "node:fs/promises";
     import path from "node:path";
     import { pathToFileURL } from "node:url";
     import { BroadcastChannel } from "node:worker_threads";
     import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
     import { captureRuntimeWorkerSource } from ${JSON.stringify(new URL("./runtime-worker-generation.ts", import.meta.url).href)};
     import { openSqliteWorkerStore } from ${JSON.stringify(new URL("./sqlite-worker-store.ts", import.meta.url).href)};
     import { installCliSignalExitHandlers, registerSignalExitGate } from ${JSON.stringify(new URL("../cli/signal-exit-barrier.ts", import.meta.url).href)};
     import { exitCliAfterOutput, runCliWithExitFinalization } from ${JSON.stringify(new URL("../cli/one-shot-exit.ts", import.meta.url).href)};
     import { defaultRuntime } from ${JSON.stringify(new URL("../runtime.ts", import.meta.url).href)};
     const root = ${JSON.stringify(root)};
     const outcome = ${JSON.stringify(exit)};
     const uninstall = installCliSignalExitHandlers();
     const channel = new BroadcastChannel(${JSON.stringify(databasePath)});
     channel.onmessage = ({ data }) => {
       if (data === "native-close-started") channel.postMessage("release-native-close");
     };
     await runCliWithExitFinalization({
       run: () => withRetainedUpdateRuntime(pathToFileURL(path.join(root, "dist/updater.mjs")).href, async (retain) => {
         await retain({ mutationRoots: [root], timeoutMs: 30000, assertCurrent() {} });
         const source = captureRuntimeWorkerSource(pathToFileURL(path.join(root, "dist/store.mjs")));
         const store = await openSqliteWorkerStore({ ...source, databasePath: ${JSON.stringify(databasePath)},
           input: { channel: ${JSON.stringify(databasePath)}, delayClose: true } });
         await store.execute({ type: "append", input: "owned write settled" });
         const retained = (await fs.readdir(path.dirname(root))).filter(name => name.startsWith("openclaw-update-runtime-"));
         process.stdout.write(JSON.stringify({ retained }) + "\\n");
         if (outcome === "failure-report") {
           defaultRuntime.error("Update failure reported");
           exitCliAfterOutput(defaultRuntime, 1);
         }
         const interrupted = Promise.withResolvers();
         const unregister = registerSignalExitGate(interrupted.promise, () => interrupted.resolve());
         try {
           process.kill(process.pid, outcome);
           await interrupted.promise;
           process.stdout.write("signal command unwound\\n");
         } finally {
           unregister();
         }
       }),
       onError(error) { process.stderr.write("Unexpected error: " + String(error)); process.exitCode = 2; },
     });
     channel.close();
     uninstall();
     process.stdout.write("natural finalization completed\\n");`,
      {
        imports: [import.meta.resolve("tsx")],
        input: "",
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: base,
          TMPDIR: base,
          OPENCLAW_STATE_DIR: path.join(base, "state"),
          OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
          XDG_CACHE_HOME: path.join(base, "cache"),
          OPENCLAW_LOG_LEVEL: "warn",
        },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(code);
    expect(result.signal, result.stderr).toBeNull();
    expect(result.stdout).toMatch(/"retained":\["openclaw-update-runtime-[A-Za-z0-9]{6}"\]/u);
    expect(result.stdout).toContain("natural finalization completed");
    if (exit !== "failure-report") {
      expect(result.stdout).toContain("signal command unwound");
    }
    if (exit === "failure-report") {
      expect(result.stderr).toContain("Update failure reported");
      expect(result.stderr).not.toContain("Unexpected error:");
    }
    expect(result.stderr).toContain("worker generation settled; cleanup deferred");
    const retained = (await fs.readdir(base)).filter((name) =>
      name.startsWith("openclaw-update-runtime-"),
    );
    expect(retained).toHaveLength(1);
    const physicalRoot = await fs.realpath(root);
    const volume = path.parse(physicalRoot).root;
    const projection = path.join(
      base,
      retained[0]!,
      "tree",
      Buffer.from(volume).toString("hex"),
      path.relative(volume, physicalRoot),
    );
    expect(await fs.readFile(path.join(projection, "dist/store.mjs"), "utf8")).toBe(
      await fs.readFile(path.join(root, "dist/store.mjs"), "utf8"),
    );
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("BEGIN EXCLUSIVE");
      expect(db.prepare("SELECT value FROM entries").all()).toEqual([
        { value: "owned write settled" },
      ]);
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  },
);

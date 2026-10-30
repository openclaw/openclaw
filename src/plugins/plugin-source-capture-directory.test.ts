import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cleanupStartupPluginSourceCaptures } from "../commands/startup-plugin-source-captures.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as census from "../infra/openclaw-process-census.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { acquireSqliteStagingToken } from "../infra/sqlite-staging-token.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { retainGatewayPluginMetadata } from "./plugin-metadata-lifecycle.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { resolvePluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  createPluginNativeCaptureRoot,
  createPluginSourceCaptureRoot,
  prunePluginNativeCaptureDirectories,
  retainPluginSourceCaptureInstance,
} from "./plugin-source-capture-directory.js";
import { sweepPluginSourceCapturesForTest } from "./plugin-source-capture-directory.test-support.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

const temp = createTempDirTracker();
const cleanups: (() => unknown)[] = [];
const artifactUrl = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.artifact);
const artifactModule = artifactUrl.href;
const runtimeArgs = resolveRuntimeWorkerArgv(artifactUrl).slice(0, -1);
const moduleSpecifier = (name: keyof typeof pluginProcessRuntimeEntrypoints) =>
  JSON.stringify(resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints[name]).href);
const hour = 60 * 60 * 1_000;
const capturedSource = "module.exports = 'captured';\n";
let stateDir: string;
let source: string;

beforeEach(() => {
  const runtimeTemp = temp.make("plugin-capture-runtime-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, runtimeTemp);
  }
  stateDir = temp.make("plugin-capture-state-");
  source = temp.make("plugin-capture-input-");
  fs.writeFileSync(path.join(source, "index.cjs"), capturedSource);
});

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    // Release capture owners before removing their state or restoring environment/mocks.
    while (cleanups.length) {
      try {
        await cleanups.pop()!();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Capture fixture cleanup failed");
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    temp.cleanup();
  }
});

function age(directory: string): void {
  const timestamp = new Date(Date.now() - 2 * hour);
  fs.utimesSync(directory, timestamp, timestamp);
}

function expectBytes(file: string, bytes = capturedSource) {
  expect(fs.readFileSync(file, "utf8")).toBe(bytes);
}

function exists(file: string, expected = false) {
  expect(fs.existsSync(file)).toBe(expected);
}

function captureFixture() {
  const instance = retainPluginSourceCaptureInstance(stateDir);
  cleanups.push(async () => {
    vi.restoreAllMocks();
    await instance.releaseAsync();
    await sweepPluginSourceCapturesForTest(stateDir);
  });
  const capture = instance.createDirectory();
  const root = path.dirname(path.dirname(capture));
  const payload = path.join(capture, "index.cjs");
  fs.writeFileSync(payload, capturedSource);
  return { instance, capture, root, payload };
}

it("keeps update source copies in TMPDIR without relocating retained native captures", () => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const artifact = artifactFixture();
  expectArtifactBytes(artifact);
  expect(
    artifact.boundaryRoot.startsWith(path.join(process.env.TMPDIR!, "openclaw-plugin-captures-")),
  ).toBe(true);
  const native = createPluginNativeCaptureRoot(stateDir);
  cleanups.push(() => native.disposeAsync());
  const storage = resolvePluginSourceCaptureStorage();
  const preparedNative = createPluginNativeCaptureRoot(storage.stateDir, storage.placement);
  cleanups.push(() => preparedNative.disposeAsync());
  expect(
    native.directory.startsWith(path.join(stateDir, "tmp", "plugin-captures") + path.sep),
  ).toBe(true);
  expect(
    preparedNative.directory.startsWith(path.join(stateDir, "tmp", "plugin-captures") + path.sep),
  ).toBe(true);
});

function metadataFixture(scheduler = createTestGatewayScheduler()) {
  const metadata = retainGatewayPluginMetadata(scheduler);
  cleanups.push(() => metadata.close());
  return metadata;
}

it("keeps update plugin captures on the selected temporary volume", async () => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  const { capture, root } = captureFixture();
  expect(root.startsWith(`${process.env.TMPDIR}${path.sep}`)).toBe(true);
  const artifact = artifactFixture(capture);
  expectArtifactBytes(artifact);
  expect(fs.existsSync(path.join(stateDir, "tmp", "plugin-captures"))).toBe(false);
});

function artifactFixture(directory?: string, managedRoot?: string) {
  const create = () => capturePluginGenerationArtifact(source);
  const artifact = directory
    ? withPluginSourceCaptureDirectory(directory, create, managedRoot)
    : create();
  cleanups.push(() => artifact.disposeAsync());
  return artifact;
}

function expectArtifactBytes(artifact: ReturnType<typeof capturePluginGenerationArtifact>) {
  expectBytes(artifact.resolve(path.join(source, "index.cjs")));
}

function runChild(script: string, args: string[] = [], exitCode = 0, execArgv: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [...execArgv, ...runtimeArgs, "--input-type=module", "-e", script, ...args],
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, encoding: "utf8", timeout: 15_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(exitCode);
  return result;
}

it("does not retain the caller that first imports source capture storage", () => {
  runChild(
    `
    import assert from "node:assert/strict";
    import { AsyncLocalStorage } from "node:async_hooks";
    import { setImmediate } from "node:timers/promises";
    await import(${moduleSpecifier("scheduler")});
    const caller = new AsyncLocalStorage();
    async function load() {
      const payload = { text: "synthetic caller context" };
      const reference = new WeakRef(payload);
      await caller.run(payload, () => import(${moduleSpecifier("captureDirectory")}));
      return reference;
    }
    const reference = await load();
    function unowned() { return new WeakRef({ unowned: true }); }
    const control = unowned();
    try {
      for (let pass = 0; pass < 8; pass++) {
        await setImmediate();
        globalThis.gc();
      }
      assert.equal(control.deref(), undefined, "Unowned control must collect");
      assert.equal(reference.deref(), undefined, "Source capture import retained its caller");
    } finally {
      caller.disable();
    }
  `,
    [],
    0,
    ["--expose-gc"],
  );
});

function capturePaths(boundaryRoot: string, capturedFile: string, worker = false) {
  const captureRoot = worker ? path.dirname(boundaryRoot) : boundaryRoot;
  const instanceRoot = path.dirname(path.dirname(captureRoot));
  // Check ownership before aging a path derived from a child or an older implementation.
  expect(path.dirname(instanceRoot)).toBe(path.join(stateDir, "tmp", "plugin-captures"));
  return { boundaryRoot, capturedFile, captureRoot, instanceRoot };
}

const childCapture = `
  import fs from "node:fs";
  import path from "node:path";
  import { capturePluginGenerationArtifact } from ${JSON.stringify(artifactModule)};
  import { createPluginSourceCaptureRoot } from ${moduleSpecifier("captureDirectory")};
  import { withPluginSourceCaptureDirectory } from ${moduleSpecifier("metadataCapture")};
  const source = process.argv[1];
  const worker = process.argv[2] === "worker"
    ? createPluginSourceCaptureRoot(process.env.OPENCLAW_STATE_DIR, "openclaw-model-catalog-")
    : undefined;
  const artifact = worker
    ? withPluginSourceCaptureDirectory(worker.directory, () => capturePluginGenerationArtifact(source))
    : capturePluginGenerationArtifact(source);
  const capturedFile = artifact.resolve(path.join(source, "index.cjs"));
  fs.writeSync(1, artifact.boundaryRoot + "\\n" + capturedFile + "\\n");
`;

// eb377ac59e6c captures held an empty MEMORY-journal database for their process lifetime.
const legacyChildCapture = `
  import fs from "node:fs";
  import path from "node:path";
  import { DatabaseSync } from "node:sqlite";
  const parent = path.join(process.env.OPENCLAW_STATE_DIR, "tmp", "plugin-captures");
  fs.mkdirSync(parent, { recursive: true });
  const instance = fs.mkdtempSync(path.join(parent, "legacy-"));
  const owner = new DatabaseSync(path.join(instance, "owner.sqlite"));
  owner.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE;");
  fs.mkdirSync(path.join(instance, "captures"));
  const boundaryRoot = fs.mkdtempSync(path.join(instance, "captures", "openclaw-plugin-build-"));
  const capturedFile = path.join(boundaryRoot, "index.cjs");
  fs.copyFileSync(path.join(process.argv[1], "index.cjs"), capturedFile);
  fs.writeSync(1, boundaryRoot + "\\n" + capturedFile + "\\n");
`;

async function abandonCapture() {
  const captured = await startCliCapture(false);
  await captured.stop();
  expectBytes(captured.capturedFile);
  return captured;
}

it("retains mapped addons through exit; reclaims at startup", async () => {
  const result = runChild(
    `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import fsp from "node:fs/promises";
      import { createRequire } from "node:module";
      import path from "node:path";
      const require = createRequire(import.meta.url);
      const exports = {};
      const failure = new Error("synthetic addon initialization failed");
      const dlopen = process.dlopen;
      process.dlopen = function(module, file, flags) {
        if (!/synthetic-addon-[0-3]\\.node$/.test(file)) return dlopen.apply(this, arguments);
        if (file.endsWith("2.node") || file.endsWith("3.node")) {
          assert.equal(this, process);
          assert.equal(flags, 17);
        }
        if (file.endsWith("3.node")) {
          captures[3].dispose();
          throw failure;
        }
        module.exports = exports;
        return exports;
      };
      const { createPluginSourceCapture } = await import(${moduleSpecifier("metadataCapture")});
      const { createPluginNativeCaptureRoot, retainPluginSourceCaptureInstance } = await import(${moduleSpecifier("captureDirectory")});
      const { GatewayScheduler } = await import(${moduleSpecifier("scheduler")});
      const captures = [createPluginSourceCapture(), createPluginSourceCapture(), createPluginNativeCaptureRoot(), createPluginNativeCaptureRoot()];
      const files = captures.map((capture, index) => path.join(capture.directory, "synthetic-addon-" + index + ".node"));
      for (const file of files) fs.writeFileSync(file, "synthetic mapped image");
      const warnings = [];
      process.emitWarning = warning => warnings.push(String(warning));
      const remove = fs.rmSync;
      const removeAsync = fsp.rm;
      let attempts = 0;
      const check = target => {
        if (files.some(file => file.startsWith(String(target) + path.sep))) {
          attempts++;
          throw Object.assign(new Error("synthetic mapped-image unlink"), { code: "EPERM" });
        }
      };
      fs.rmSync = (target, options) => { check(target); return remove(target, options); };
      fsp.rm = async (target, options) => { check(target); return removeAsync(target, options); };
      for (const file of files.slice(0, 2)) {
        assert.equal(require(file), exports);
        delete require.cache[file];
      }
      assert.equal(process.dlopen({}, path.toNamespacedPath(files[2]), 17), exports);
      assert.throws(() => process.dlopen({}, files[3], 17), error => error === failure);
      for (const [index, capture] of captures.entries()) {
        if (index % 2) await capture.disposeAsync();
        else capture.dispose();
      }
      const maintenance = retainPluginSourceCaptureInstance();
      const scheduler = new GatewayScheduler();
      try {
        await maintenance.startMaintenance(scheduler);
        assert.notEqual(scheduler.nextWakeAtMs, null);
      } finally {
        try {
          await maintenance.releaseAsync();
          assert.equal(scheduler.nextWakeAtMs, null);
        } finally {
          await scheduler.stop();
        }
      }
      assert(files.every(file => fs.existsSync(file)));
      // Registered after the capture owner, so this includes its terminal cleanup.
      process.on("exit", () => process.stdout.write(JSON.stringify({
        directories: captures.map(capture => capture.directory), warnings, attempts,
      })));
      `,
  );
  const observed: { directories: string[]; warnings: string[]; attempts: number } = JSON.parse(
    result.stdout,
  );
  expect(observed.attempts).toBe(0);
  expect(observed.warnings).toHaveLength(1);
  expect(observed.warnings[0]).toContain("retained-by-loaded-module");
  expect(result.stderr).not.toContain("cleanup failed");
  expect(observed.directories.every((directory) => fs.existsSync(directory))).toBe(true);
  // A new process has no mapped image and acquires released custody; no one-hour wait.
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  await cleanupStartupPluginSourceCaptures({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  });
  expect(warning).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.join(stateDir, "tmp", "plugin-captures"))).toEqual([]);
});

it("disposes captures while sibling workers remain active", () => {
  const result = runChild(
    `
      import { once } from "node:events";
      import { Worker } from "node:worker_threads";
      import { createPluginSourceCapture } from ${moduleSpecifier("metadataCapture")};
      const workers = Array.from({ length: 2 }, () => new Worker(
        "const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => parentPort.close()); parentPort.postMessage('ready');",
        { eval: true, execArgv: [] },
      ));
      await Promise.all(workers.map(worker => once(worker, "message")));
      try {
        for (let reload = 0; reload < 12; reload++) {
          createPluginSourceCapture().dispose();
          await createPluginSourceCapture().disposeAsync();
        }
      } finally {
        const exits = workers.map(worker => once(worker, "exit"));
        for (const worker of workers) worker.postMessage("close");
        await Promise.all(exits);
      }
      process.stdout.write("captures disposed with workers alive");
      `,
  );
  expect(result.stdout).toBe("captures disposed with workers alive");
  expect(fs.readdirSync(path.join(stateDir, "tmp", "plugin-captures"))).toEqual([]);
});

it.each(["natural", "failure", "explicit", "signal"])(
  "reclaims process-owned captures on %s exit",
  (mode) => {
    const result = runChild(
      `${childCapture}
      import { installCliSignalExitHandlers } from ${moduleSpecifier("signalExit")};
      import { createPluginNativeCaptureRoot } from ${moduleSpecifier("captureDirectory")};
      const retained = createPluginNativeCaptureRoot();
      const pending = createPluginNativeCaptureRoot();
      fs.writeFileSync(path.join(retained.directory, "native"), "published native bytes");
      fs.writeFileSync(path.join(pending.directory, "native"), "unpublished native bytes");
      retained.commit();
      fs.writeSync(1, JSON.stringify([retained.directory, pending.directory]) + "\\n");
      const mode = process.argv[2];
      if (mode === "failure") throw new Error("fixture command failed");
      if (mode === "explicit") process.exit(2);
      if (mode === "signal") {
        installCliSignalExitHandlers();
        process.emit("SIGTERM");
      }`,
      [source, mode],
      mode === "natural" ? 0 : mode === "failure" ? 1 : mode === "explicit" ? 2 : 143,
    );
    const [directory, , nativeRoots] = result.stdout.trim().split("\n");
    expect(directory).toContain(path.join(stateDir, "tmp", "plugin-captures"));
    exists(directory!);
    const [retained, pending] = JSON.parse(nativeRoots!) as [string, string];
    expectBytes(path.join(retained, "native"), "published native bytes");
    exists(pending);
    exists(path.join(path.dirname(path.dirname(retained)), "owner.sqlite"), true);
  },
);

it("reclaims on signal even when the process outlives its drain", async () => {
  const live = await startCliCapture(false);
  cleanups.push(live.stop);
  const signalled = await startCliCapture(false, false, true);
  cleanups.push(signalled.stop);
  exists(signalled.instanceRoot, true);
  signalled.child.kill("SIGTERM");
  expect(await signalled.nextLine()).toBe("drained");
  expect(signalled.child.exitCode).toBeNull();
  exists(signalled.instanceRoot);
  expect(await live.read()).toBe(capturedSource.trimEnd());
});

async function startCliCapture(worker: boolean, legacy = false, signal = false) {
  const script = signal
    ? `import { installCliSignalExitHandlers, registerSignalExitFinalizer } from ${moduleSpecifier("signalExit")};
      installCliSignalExitHandlers();
      ${childCapture}
      registerSignalExitFinalizer(async () => fs.writeSync(1, "drained\\n"));
      setInterval(() => {}, 60_000);`
    : `${legacy ? legacyChildCapture : childCapture}
       process.stdin.on("data", () => fs.writeSync(1, fs.readFileSync(capturedFile)));
       process.stdin.resume();`;
  const child = spawn(
    process.execPath,
    [
      ...(legacy ? [] : runtimeArgs),
      "--input-type=module",
      "-e",
      script,
      source,
      worker ? "worker" : "cli",
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        ...(signal ? {} : { TMPDIR: stateDir, TMP: stateDir, TEMP: stateDir }),
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: signal ? undefined : 15_000,
    },
  );
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, "close");
  void exited.catch(() => {});
  const nextLine = async () => {
    const result = await lines.next();
    if (result.done) {
      throw new Error(`Capture child exited before replying: ${stderr}`);
    }
    return result.value;
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    reader.close();
  };
  try {
    const boundaryRoot = await nextLine();
    const capturedFile = await nextLine();
    return {
      ...capturePaths(boundaryRoot, capturedFile, worker),
      child,
      nextLine,
      async read() {
        child.stdin.write("read\n");
        return await nextLine();
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

it("metadata boot preserves recent and other producers' legacy captures", async () => {
  vi.spyOn(census, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [12345] });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const active = artifactFixture();
  cleanups.unshift(() => sweepPluginSourceCapturesForTest(stateDir));
  await sweepPluginSourceCapturesForTest(stateDir);
  const old = await abandonCapture();
  const recent = await abandonCapture();
  age(old.instanceRoot);
  const legacy = path.join(temp.make("plugin-capture-legacy-"), "openclaw-plugin-build-legacy");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "sentinel"), "legacy files have no custody token");
  age(legacy);
  vi.stubEnv("TMPDIR", path.dirname(legacy));

  const time = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(time.clock);
  const readDirectories = vi.spyOn(fsPromises, "readdir");
  metadataFixture(scheduler);
  cleanups.push(() => scheduler.stop());
  expect(readDirectories).toHaveBeenCalled();
  await sweepPluginSourceCapturesForTest(stateDir);
  exists(old.instanceRoot);
  expectArtifactBytes(active);
  expectBytes(recent.capturedFile);
  expectBytes(path.join(legacy, "sentinel"), "legacy files have no custody token");
  readDirectories.mockClear();
  const later = artifactFixture();
  await time.advanceBy(0);
  expect(readDirectories).not.toHaveBeenCalled();
  later.dispose();
}, 30_000);

it.each([
  { worker: false, legacy: false },
  { worker: true, legacy: false },
  { worker: false, legacy: true },
])(
  "preserves custody until SIGKILL (worker: $worker, legacy: $legacy)",
  async ({ worker, legacy }) => {
    const child = await startCliCapture(worker, legacy);
    cleanups.push(child.stop);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    age(child.instanceRoot);
    metadataFixture();
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(await child.read()).toBe(capturedSource.trim());
    exists(child.captureRoot, true);
    expectBytes(child.capturedFile);
    await child.stop();
    expectBytes(child.capturedFile);
    if (legacy) {
      const recent = new Date();
      fs.utimesSync(child.instanceRoot, recent, recent);
      await sweepPluginSourceCapturesForTest(stateDir);
      expectBytes(child.capturedFile);
      age(child.instanceRoot);
    }
    await sweepPluginSourceCapturesForTest(stateDir);
    exists(child.instanceRoot);
    exists(child.captureRoot);
  },
  30_000,
);

it.each(["payload", "instance"])(
  "retries partial %s removal failures",
  async (stage) => {
    const orphan = await abandonCapture();
    age(orphan.instanceRoot);
    const captures = path.dirname(orphan.boundaryRoot);
    if (stage === "payload") {
      let admitted = true;
      const lstat = fsPromises.lstat.bind(fsPromises);
      const inspected = vi
        .spyOn(fsPromises, "lstat")
        .mockImplementation(async (target, options) => {
          const result = await lstat(target, options);
          if (String(target) === orphan.instanceRoot) {
            admitted = false;
          }
          return result;
        });
      try {
        const refused = await prunePluginNativeCaptureDirectories(stateDir, new Set(), async () => {
          await Promise.resolve();
          if (!admitted) {
            throw new Error("Fixture cleanup authority expired");
          }
        });
        expect(refused.warnings).toContain("Fixture cleanup authority expired");
        expectBytes(orphan.capturedFile);
      } finally {
        inspected.mockRestore();
      }
    }
    const remove = fsPromises.rm.bind(fsPromises);
    const failure = Object.assign(new Error("Fixture cleanup cannot finish"), { code: "EACCES" });
    const fault = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (target === (stage === "payload" ? captures : orphan.instanceRoot)) {
        throw failure;
      }
      await remove(target, options);
    });
    try {
      await sweepPluginSourceCapturesForTest(stateDir);
      exists(path.join(orphan.instanceRoot, "owner.sqlite"), true);
      if (stage === "payload") {
        expectBytes(orphan.capturedFile);
      } else {
        exists(captures);
      }
    } finally {
      fault.mockRestore();
    }
    age(orphan.instanceRoot);
    await sweepPluginSourceCapturesForTest(stateDir);
    exists(orphan.instanceRoot);
  },
  30_000,
);

it("metadata retirement joins its sweep, not sibling schedules", async () => {
  const root = path.join(stateDir, "tmp", "plugin-captures");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const time = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(time.clock);
  const metadata = retainGatewayPluginMetadata(scheduler);
  await sweepPluginSourceCapturesForTest(stateDir);
  const orphan = path.join(root, "abandoned");
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "payload"), "reconstructible capture");
  acquireSqliteStagingToken(orphan, "create")();
  age(orphan);
  const entered = createDeferred();
  const release = createDeferred();
  const remove = fsPromises.rm.bind(fsPromises);
  const removal = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    if (path.dirname(String(target)) === root) {
      entered.resolve();
      await release.promise;
    }
    await remove(target, options);
  });
  const sweep = time.advanceBy(hour);
  let closing: ReturnType<typeof metadata.close> | undefined;
  try {
    await entered.promise;
    let closed = false;
    closing = metadata.close().then((result) => {
      closed = true;
      return result;
    });
    const sibling = vi.fn();
    scheduler.schedule({ id: "capture-maintenance-sibling", delayMs: 0, run: sibling });
    await time.advanceBy(0);
    await fsPromises.stat(stateDir);
    expect(closed).toBe(false);
    expect(sibling).toHaveBeenCalledOnce();
    expect(scheduler.signal.aborted).toBe(false);
    release.resolve();
    await Promise.all([sweep, closing]);
    expect(closed).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(scheduler.nextWakeAtMs).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled([sweep, closing]);
    removal.mockRestore();
    await metadata.close();
    await scheduler.stop();
  }
});

it.each(["before command", "inside command"])(
  "allocates without timers after import %s",
  (importOrder) => {
    const result = runChild(
      `
        import { AsyncLocalStorage, createHook } from "node:async_hooks";
        import fs from "node:fs";
        import path from "node:path";
        import { withCliCommandCleanup, withCliProcessScope } from ${moduleSpecifier("cleanupScope")};
        const load = () => import(${JSON.stringify(artifactModule)});
        if (process.argv[2] === "before command") await load();
        const request = new AsyncLocalStorage();
        const observed = [];
        const hook = createHook({ init(id, type) {
          if (type === "Timeout") observed.push(type);
        }});
        const { artifact: first, cleanup } = await request.run("first-command", () =>
          withCliProcessScope(() => withCliCommandCleanup(false, async (cleanup) => {
            const { capturePluginGenerationArtifact } = await load();
            hook.enable();
            try {
              return { artifact: capturePluginGenerationArtifact(process.argv[1]), cleanup };
            } finally {
              hook.disable();
            }
          })),
        );
        const { capturePluginGenerationArtifact } = await load();
        const survivor = capturePluginGenerationArtifact(process.argv[1]);
        first.dispose();
        await cleanup.pluginResources.release();
        try {
          process.stdout.write(JSON.stringify({
            timers: observed,
            source: fs.readFileSync(survivor.resolve(path.join(process.argv[1], "index.cjs")), "utf8"),
          }));
        } finally {
          survivor.dispose();
        }
        `,
      [source, importOrder],
    );
    expect(JSON.parse(result.stdout)).toEqual({
      timers: [],
      source: capturedSource,
    });
  },
);

it("retains bytes until metadata and artifact release", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const first = metadataFixture();
  const artifact = artifactFixture();
  const { instanceRoot } = capturePaths(
    artifact.boundaryRoot,
    artifact.resolve(path.join(source, "index.cjs")),
  );
  age(instanceRoot);
  await sweepPluginSourceCapturesForTest(stateDir);
  expectArtifactBytes(artifact);
  await first.close();
  await first.close();
  await sweepPluginSourceCapturesForTest(stateDir);
  expectArtifactBytes(artifact);
  await artifact.disposeAsync();
  exists(instanceRoot);
});

it.skipIf(process.platform === "win32").each([
  { removed: "directory", closeFails: false },
  { removed: "token", closeFails: false },
  { removed: "directory", closeFails: true },
])(
  "disposes missing $removed, retaining custody after close failure ($closeFails)",
  async ({ removed, closeFails }) => {
    const open = nodeSqlite.openNodeSqliteDatabase;
    let database: ReturnType<typeof open> | undefined;
    const failure = new Error("Fixture native close is still pending");
    if (closeFails) {
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
        const opened = open(...args);
        database = opened;
        vi.spyOn(opened, "close").mockImplementationOnce(() => {
          throw failure;
        });
        return opened;
      });
    }
    const { instance, capture, root, payload } = captureFixture();
    fs.rmSync(removed === "directory" ? root : path.join(root, "owner.sqlite"), {
      recursive: true,
    });
    if (closeFails) {
      await expect(instance.releaseAsync()).rejects.toBe(failure);
      expect(database?.isOpen).toBe(true);
      expect(() => retainPluginSourceCaptureInstance(stateDir)).toThrow(
        "Plugin source instance cleanup is incomplete",
      );
    }
    await expect(instance.releaseAsync()).resolves.toBeUndefined();
    if (closeFails) {
      expect(database?.isOpen).toBe(false);
      vi.restoreAllMocks();
    }
    if (removed === "directory") {
      exists(root);
    } else {
      expectBytes(payload);
      exists(path.join(root, "owner.sqlite"));
    }
    const successor = retainPluginSourceCaptureInstance(stateDir);
    cleanups.push(() => successor.releaseAsync());
    expect(successor.createDirectory()).not.toBe(capture);
  },
);

it.skipIf(process.platform === "win32").each(["directory", "token"] as const)(
  "preserves replacement %s during disposal",
  async (replaced) => {
    const { instance, capture, root } = captureFixture();
    const target = replaced === "directory" ? root : path.join(root, "owner.sqlite");
    const parked = path.join(stateDir, "original");
    fs.renameSync(target, parked);
    if (replaced === "directory") {
      fs.mkdirSync(target);
    }
    const replacement = replaced === "directory" ? path.join(target, "sentinel") : target;
    fs.writeFileSync(replacement, "replacement bytes");
    cleanups.push(() => {
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(parked, target);
    });
    await expect(instance.releaseAsync()).rejects.toThrow(
      "SQLite staging ownership changed before retirement",
    );
    expectBytes(replacement, "replacement bytes");
    const originalCapture =
      replaced === "directory" ? path.join(parked, path.relative(root, capture)) : capture;
    expectBytes(path.join(originalCapture, "index.cjs"));
  },
);

it("leaves worker directories under caller custody", async () => {
  const workerRoot = temp.make("plugin-capture-worker-");
  fs.writeFileSync(path.join(workerRoot, "sentinel"), "worker owns this directory");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const artifact = artifactFixture(workerRoot);
  age(artifact.boundaryRoot);
  const metadata = metadataFixture();
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(path.dirname(artifact.boundaryRoot)).toBe(workerRoot);
  expectArtifactBytes(artifact);
  await metadata.close();
  await artifact.disposeAsync();
  exists(artifact.boundaryRoot);
  expectBytes(path.join(workerRoot, "sentinel"), "worker owns this directory");
});

it("excludes worker output when state is also source", async () => {
  const root = createPluginSourceCaptureRoot(source, "openclaw-model-catalog-");
  cleanups.push(() => root.release());
  const artifact = artifactFixture(root.directory, root.managedRoot);
  expectArtifactBytes(artifact);
  exists(path.join(artifact.rootDir, "tmp", "plugin-captures"));
});

it("boots metadata and captures when the state path is a file", async () => {
  const parent = temp.make("plugin-capture-malformed-state-");
  stateDir = path.join(parent, "state");
  fs.writeFileSync(stateDir, "not a directory");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const metadata = metadataFixture();
  await sweepPluginSourceCapturesForTest(stateDir);
  const artifact = artifactFixture();
  const instanceRoot = path.dirname(path.dirname(artifact.boundaryRoot));
  expectArtifactBytes(artifact);
  expectBytes(stateDir, "not a directory");
  await artifact.disposeAsync();
  await metadata.close();
  exists(instanceRoot);
});

it.each(["malformed", "symlink", "hardlink", "sidecar-symlink", "captures-symlink"])(
  "preserves unsafe %s markers and payloads",
  async (kind) => {
    const instance = path.join(stateDir, "tmp", "plugin-captures", "legacy");
    const captures = path.join(instance, "captures");
    const outside = temp.make("plugin-capture-unrelated-");
    const outsideFile = path.join(outside, "marker");
    fs.writeFileSync(outsideFile, "unrelated source");
    fs.mkdirSync(instance, { recursive: true });
    if (kind === "captures-symlink") {
      fs.symlinkSync(outside, captures, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.mkdirSync(captures);
      fs.writeFileSync(path.join(captures, "index.cjs"), capturedSource);
    }
    const owner = path.join(instance, "owner.sqlite");
    if (kind === "symlink") {
      fs.symlinkSync(outsideFile, owner, "file");
    } else if (kind === "hardlink") {
      fs.linkSync(outsideFile, owner);
    } else {
      fs.writeFileSync(owner, kind === "malformed" ? "not a SQLite owner" : "");
    }
    if (kind === "sidecar-symlink") {
      fs.symlinkSync(outsideFile, `${owner}-journal`, "file");
    }
    const before = fs.readdirSync(instance).toSorted();
    age(instance);
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    await sweepPluginSourceCapturesForTest(stateDir);

    expect(fs.readdirSync(instance).toSorted()).toEqual(before);
    expectBytes(outsideFile, "unrelated source");
    if (kind !== "captures-symlink") {
      expectBytes(path.join(captures, "index.cjs"));
    }
    if (kind === "malformed") {
      expectBytes(owner, "not a SQLite owner");
    }
  },
);

it("summarizes inaccessible owner records and retries cleanup", async () => {
  const root = path.join(stateDir, "tmp", "plugin-captures");
  const orphan = await abandonCapture();
  const owner = fs.readFileSync(path.join(orphan.instanceRoot, "owner.sqlite"));
  fs.rmSync(orphan.instanceRoot, { recursive: true });
  for (let index = 0; index < 3; index++) {
    const directory = path.join(root, String(index));
    fs.mkdirSync(path.join(directory, "captures"), { recursive: true });
    fs.writeFileSync(path.join(directory, "owner.sqlite"), owner);
    age(directory);
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const lstat = fsPromises.lstat.bind(fsPromises);
  const fault = vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
    if (path.dirname(String(target)) === root) {
      throw Object.assign(new Error("Fixture owner record is inaccessible"), { code: "EACCES" });
    }
    return lstat(target, options);
  });
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(String(warning.mock.calls[0]?.[0])).toContain("3 cleanup failure(s)");
  fault.mockRestore();
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(fs.readdirSync(root)).toEqual([]);
});

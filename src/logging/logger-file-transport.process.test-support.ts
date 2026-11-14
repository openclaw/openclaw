import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { runWithWorkerStartObserver } from "../infra/worker-request-diagnostics.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { fileLogTransport } from "./logger-file-transport.js";
import {
  applyLoggingConfig,
  getChildLogger,
  getLogger,
  getResolvedLoggerSettings,
  setLoggerOverride,
} from "./logger.js";

async function withoutSyncFs(operation: () => Promise<void>): Promise<void> {
  const counts: Record<string, number> = {};
  const restore: Array<() => void> = [];
  try {
    // Linux exposes unsupported methods such as lchmodSync as undefined.
    for (const key of Object.keys(fs).filter(
      (name) => name.endsWith("Sync") && typeof Reflect.get(fs, name) === "function",
    )) {
      const descriptor = Object.getOwnPropertyDescriptor(fs, key)!;
      Object.defineProperty(fs, key, {
        ...descriptor,
        value: new Proxy(descriptor.value, {
          apply(fn, receiver, args) {
            counts[key] = (counts[key] ?? 0) + 1;
            return Reflect.apply(fn, receiver, args);
          },
        }),
      });
      restore.push(() => Object.defineProperty(fs, key, descriptor));
    }
    const nativeRealpath = Object.getOwnPropertyDescriptor(fs.realpathSync, "native")!;
    Object.defineProperty(fs.realpathSync, "native", {
      ...nativeRealpath,
      value: new Proxy(nativeRealpath.value, {
        apply(fn, receiver, args) {
          counts["realpathSync.native"] = (counts["realpathSync.native"] ?? 0) + 1;
          return Reflect.apply(fn, receiver, args);
        },
      }),
    });
    restore.push(() => {
      Object.defineProperty(fs.realpathSync, "native", nativeRealpath);
    });
    await operation();
  } finally {
    restore.toReversed().forEach((undo) => undo());
  }
  assert.deepEqual(counts, {}, "Ordinary logger I/O must not block the main thread");
}

const directory: string = isMainThread ? process.argv[2]! : workerData.directory;
const starts: string[] = [];

async function proveDefaultTargets(): Promise<void> {
  const state = path.join(directory, "captured-state");
  process.env.OPENCLAW_STATE_DIR = state;
  const preferred = path.join(state, "logs");
  process.env.OPENCLAW_PROFILE = "default-proof";
  setLoggerOverride(null);
  applyLoggingConfig(undefined);
  const child = getChildLogger({ subsystem: "session-sqlite" });
  let initialFile = "";
  await withoutSyncFs(async () => {
    initialFile = (await getResolvedLoggerSettings()).file;
  });
  assert.equal(path.dirname(initialFile), preferred);
  const old = path.join(preferred, "openclaw-2000-01-01.log");
  fs.writeFileSync(old, "synthetic old log\n");
  fs.utimesSync(old, 0, 0);
  await getResolvedLoggerSettings();
  assert.ok(fs.existsSync(old), "Reporting a path must not prune logs");
  const explicit = path.join(directory, "reloaded.log");
  await withoutSyncFs(async () => {
    child.warn("queued default target");
    applyLoggingConfig({ level: "info", file: explicit });
    child.warn("queued explicit target");
    await fileLogTransport.flush();
  });
  assert.match(fs.readFileSync(initialFile, "utf8"), /queued default target/);
  assert.doesNotMatch(fs.readFileSync(initialFile, "utf8"), /queued explicit target/);
  assert.match(fs.readFileSync(explicit, "utf8"), /queued explicit target/);
  assert.equal(fs.existsSync(old), false, "The first write retains rolling-log pruning");

  fs.rmSync(preferred, { recursive: true });
  fs.symlinkSync(directory, preferred);
  const unsafe = path.join(directory, "unsafe");
  fs.mkdirSync(unsafe, { mode: 0o777 });
  fs.chmodSync(unsafe, 0o777);
  process.env.TMPDIR = unsafe;
  process.env.OPENCLAW_STATE_DIR = state;
  process.env.OPENCLAW_PROFILE = "fallback-proof";
  applyLoggingConfig(undefined);
  let fallbackFile = "";
  await withoutSyncFs(async () => {
    child.warn("captured default fallback");
    process.env.OPENCLAW_STATE_DIR = path.join(directory, "later-state");
    fallbackFile = (await getResolvedLoggerSettings()).file;
    await fileLogTransport.flush();
  });
  assert.equal(path.dirname(path.dirname(fallbackFile)), path.join(state, "tmp"));
  assert.match(fs.readFileSync(fallbackFile, "utf8"), /captured default fallback/);

  fs.unlinkSync(preferred);
  fs.mkdirSync(preferred, { mode: 0o700 });
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 24 * 60 * 60 * 1000 });
  let rolledFile = "";
  try {
    await withoutSyncFs(async () => {
      rolledFile = (await getResolvedLoggerSettings()).file;
      assert.notEqual(path.basename(rolledFile), path.basename(fallbackFile));
      assert.equal(path.dirname(rolledFile), path.dirname(fallbackFile));
      child.warn("next day same directory");
      await fileLogTransport.flush();
    });
    assert.match(fs.readFileSync(rolledFile, "utf8"), /next day same directory/);
  } finally {
    mock.timers.reset();
  }
  fs.rmdirSync(preferred);
  fs.symlinkSync(directory, preferred);

  process.env.OPENCLAW_STATE_DIR = path.join(unsafe, "rejected-state");
  applyLoggingConfig(undefined);
  await withoutSyncFs(async () => {
    await assert.rejects(getResolvedLoggerSettings(), /No safe OpenClaw temp root/);
    child.warn("refused default target");
    await fileLogTransport.flush();
  });
  assert.doesNotMatch(fs.readFileSync(fallbackFile, "utf8"), /refused default target/);
  const rejectedFilename = path.basename(fallbackFile);
  const scopedRoot = `openclaw-${process.getuid?.()}`;
  for (const rejectedRoot of [
    path.join(unsafe, scopedRoot),
    path.join(unsafe, "rejected-state", "tmp", scopedRoot),
  ]) {
    assert.equal(fs.existsSync(path.join(rejectedRoot, rejectedFilename)), false);
  }
  assert.equal(fs.existsSync(path.join(process.cwd(), path.basename(fallbackFile))), false);

  process.env.OPENCLAW_STATE_DIR = state;
  applyLoggingConfig(undefined);
  child.warn("forced default rescue");
  fileLogTransport.drainSync();
  assert.match(
    fs.readFileSync((await getResolvedLoggerSettings()).file, "utf8"),
    /forced default rescue/,
  );
  assert.equal(starts.length, 1);
  await drainGlobalSingletonLifecycleState();
  process.stdout.write(
    JSON.stringify({
      defaultAppend: true,
      reload: true,
      fallback: true,
      rollover: true,
      refusal: true,
      forcedRescue: true,
      mainThreadSyncCalls: 0,
      workers: starts.length,
    }) + "\n",
  );
}

await runWithWorkerStartObserver(
  (script) => starts.push(script),
  async () => {
    applyLoggingConfig({
      level: "info",
      file: path.join(directory, isMainThread ? "warm.log" : "nested.log"),
    });
    const sourceMapPolicy = process.env.TSLOG_SOURCE_MAPS;
    getLogger().info("warm transport");
    assert.equal(
      process.env.TSLOG_SOURCE_MAPS,
      sourceMapPolicy,
      "Logger construction must preserve the environment captured by runtime workers",
    );
    await fileLogTransport.flush();
    if (!isMainThread) {
      assert.deepEqual(starts, [], "Worker logging must not start another logging worker");
      await drainGlobalSingletonLifecycleState();
      return;
    }
    if (process.argv[3] === "--disposable-default-root") {
      await proveDefaultTargets();
      return;
    }
    const file = path.join(directory, "rotating.log");
    setLoggerOverride({ level: "info", file, maxFileBytes: 1024 });
    const logger = getLogger();
    await withoutSyncFs(async () => {
      setLoggerOverride(null);
      applyLoggingConfig(undefined);
      getChildLogger({ subsystem: "session-sqlite" });
      const initial = await getResolvedLoggerSettings();
      applyLoggingConfig({ level: "debug" });
      getChildLogger({ subsystem: "session-sqlite" });
      const reloaded = await getResolvedLoggerSettings();
      assert.equal(reloaded.file, initial.file);
      assert.equal(reloaded.level, "debug");
      assert.ok(path.isAbsolute(reloaded.file));
      setLoggerOverride({ level: "info", file, maxFileBytes: 1024 });
      for (let index = 0; index < 23; index++) {
        logger.info({ index }, "synthetic file transport record");
        await fileLogTransport.flush();
      }
    });
    const lastRecord = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)!);
    assert.equal(lastRecord[0].index, 22);
    assert.match(lastRecord._meta.path.fileName, /logger-file-transport/);
    assert.match(
      fs.readFileSync(file.replace(/\.log$/, ".1.log"), "utf8"),
      /synthetic file transport record/,
    );

    const failed = path.join(directory, "failed.log");
    fs.mkdirSync(failed);
    setLoggerOverride({ level: "info", file: failed });
    getLogger().info("rejected target");
    await fileLogTransport.flush();
    fs.rmdirSync(failed);
    getLogger().info("recovered target");
    await fileLogTransport.flush();
    assert.match(fs.readFileSync(failed, "utf8"), /recovered target/);
    assert.equal(starts.length, 1, "One serial logger worker owns all file targets");

    getLogger().info("lifecycle drain");
    await drainGlobalSingletonLifecycleState();
    assert.match(fs.readFileSync(failed, "utf8"), /lifecycle drain/);
    const worker = new Worker(new URL(import.meta.url), { workerData: { directory } });
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Nested logger failed: ${code}`)),
      );
    });
    assert.match(fs.readFileSync(path.join(directory, "nested.log"), "utf8"), /warm transport/);

    // The existing explicit diagnostic opt-in keeps source-map resolution available.
    process.env.TSLOG_SOURCE_MAPS = "on";
    setLoggerOverride({ level: "info", file: path.join(directory, "diagnostic.log") });
    const diagnostic = getLogger();
    assert.equal(process.env.TSLOG_SOURCE_MAPS, "on");
    let sourceReads = 0;
    const read = fs.readFileSync;
    fs.readFileSync = new Proxy(read, {
      apply(fn, receiver, args) {
        sourceReads++;
        return Reflect.apply(fn, receiver, args);
      },
    });
    try {
      diagnostic.info("explicit source-map diagnostics");
    } finally {
      fs.readFileSync = read;
    }
    assert.ok(sourceReads > 0, "Explicit tslog source-map opt-in remains effective");
    await fileLogTransport.flush();
    await drainGlobalSingletonLifecycleState();
  },
);

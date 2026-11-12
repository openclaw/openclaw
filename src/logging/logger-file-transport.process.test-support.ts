import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { runWithWorkerStartObserver } from "../infra/worker-request-diagnostics.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { fileLogTransport } from "./logger-file-transport.js";
import { getLogger, setLoggerOverride } from "./logger.js";

const directory: string = isMainThread ? process.argv[2]! : workerData.directory;
const starts: string[] = [];
await runWithWorkerStartObserver(
  (script) => starts.push(script),
  async () => {
    setLoggerOverride({
      level: "info",
      file: path.join(directory, isMainThread ? "warm.log" : "nested.log"),
    });
    getLogger().info("warm transport");
    await fileLogTransport.flush();
    if (!isMainThread) {
      assert.deepEqual(starts, [], "Worker logging must not start another logging worker");
      await drainGlobalSingletonLifecycleState();
      return;
    }
    const file = path.join(directory, "rotating.log");
    setLoggerOverride({ level: "info", file, maxFileBytes: 1024 });
    const logger = getLogger();
    const counts: Record<string, number> = {};
    const restore: Array<() => void> = [];
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
    const nativeRealpath = fs.realpathSync.native;
    fs.realpathSync.native = new Proxy(nativeRealpath, {
      apply(fn, receiver, args) {
        counts["realpathSync.native"] = (counts["realpathSync.native"] ?? 0) + 1;
        return Reflect.apply(fn, receiver, args);
      },
    });
    restore.push(() => {
      fs.realpathSync.native = nativeRealpath;
    });
    try {
      for (let index = 0; index < 23; index++) {
        logger.info({ index }, "synthetic file transport record");
        await fileLogTransport.flush();
      }
    } finally {
      restore.toReversed().forEach((undo) => undo());
    }
    assert.deepEqual(counts, {}, "Ordinary logger I/O must not block the main thread");
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

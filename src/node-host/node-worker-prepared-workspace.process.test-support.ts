import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import workerThreads, { type WorkerOptions } from "node:worker_threads";

const Worker = workerThreads.Worker;
workerThreads.Worker = class extends Worker {
  constructor(filename: string | URL, options: WorkerOptions = {}) {
    super(filename, {
      ...options,
      execArgv: [...(options.execArgv ?? []), "--import", import.meta.url],
    });
  }
};
syncBuiltinESMExports();

// Share one advanced clock across the registration process and its workers so
// settled checkpoint files and ownership heartbeats use the same timestamps.
const inheritedNow: unknown = workerThreads.getEnvironmentData(import.meta.url);
const now = typeof inheritedNow === "number" ? inheritedNow : Date.now() + 60_000;
workerThreads.setEnvironmentData(import.meta.url, now);
Date.now = () => now;
const open = fs.promises.open.bind(fs.promises);
fs.promises.open = async (...args: Parameters<typeof open>) => {
  const handle = await open(...args);
  const root = process.env.OPENCLAW_PREPARED_TEST_WORKSPACE;
  const reads = process.env.OPENCLAW_PREPARED_TEST_READS;
  if (root && reads && String(args[0]).startsWith(root + path.sep)) {
    const createReadStream = handle.createReadStream.bind(handle);
    handle.createReadStream = (...options) => {
      fs.appendFileSync(reads, "read\n");
      return createReadStream(...options);
    };
  }
  return handle;
};

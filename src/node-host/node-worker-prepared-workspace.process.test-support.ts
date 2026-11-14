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

// Preload in the registration process and its computation workers. Advancing the
// clock exercises settled checkpoint files without a real ctime-margin sleep.
const now = Date.now() + 60_000;
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

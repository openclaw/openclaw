// Preload for the built Gateway: records module resolutions first seen after SIGTERM.
// An in-place update replaces hashed dist chunks under a running Gateway, and Node
// resolves each importer's first import against the files on disk (#160674).
import fs from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { isMainThread, threadId } from "node:worker_threads";

const log = process.env.OPENCLAW_TEST_LATE_IMPORT_LOG;
if (log) {
  const marker = `${log}.sigterm`;
  const seen = new Set();
  let afterSigterm = false;
  if (isMainThread) {
    process.prependListener("SIGTERM", () => {
      afterSigterm = true;
      fs.writeFileSync(marker, "");
    });
    // Workers need the hook too; a worker spawned after SIGTERM is reported by its entry.
    const workerThreads = createRequire(import.meta.url)("node:worker_threads");
    const Worker = workerThreads.Worker;
    const self = import.meta.url;
    workerThreads.Worker = class extends Worker {
      constructor(url, options = {}) {
        super(url, {
          ...options,
          execArgv: [...(options.execArgv ?? process.execArgv), "--import", self],
        });
      }
    };
    syncBuiltinESMExports();
  }
  registerHooks({
    resolve(specifier, context, next) {
      afterSigterm ||= !isMainThread && fs.existsSync(marker);
      const key = JSON.stringify([threadId, context.parentURL ?? null, specifier]);
      if (afterSigterm && !seen.has(key) && !specifier.startsWith("node:")) {
        fs.appendFileSync(log, `${key}\n`);
      }
      seen.add(key);
      return next(specifier, context);
    },
  });
}

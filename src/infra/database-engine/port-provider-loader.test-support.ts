import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { Worker, type WorkerOptions } from "node:worker_threads";

class FixtureWorker extends Worker {
  constructor(filename: string | URL, options: WorkerOptions = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      execArgv: execArgv.includes(import.meta.url)
        ? execArgv
        : [...execArgv, "--import", import.meta.url],
    });
  }
}
// Runtime worker owners choose execArgv explicitly, so carry the fixture loader across that boundary.
Object.assign(createRequire(import.meta.url)("node:worker_threads"), { Worker: FixtureWorker });
syncBuiltinESMExports();

const fixture = new URL("./port-provider-fixture.test-support.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /^\.\/workboard-port\.[cm]?[jt]s(?:\?|$)/.test(specifier) &&
      /\/port-provider\.[cm]?[jt]s(?:\?|$)/.test(context.parentURL ?? "")
    ) {
      return { url: fixture, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

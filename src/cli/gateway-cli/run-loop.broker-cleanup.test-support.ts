import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { runWithProcessCleanupBudget } from "../../process/supervisor/cleanup-budget.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import { runGatewayLoop } from "./run-loop.js";

const trace = (line: string) => writeSync(1, `process proof: ${line}\n`);
const supervisor = getProcessSupervisor();
const release = supervisor.acquireScopeCleanup("expired-child", { processTree: "required-all" });
const run = await supervisor.spawn({
  mode: "child",
  scopeKey: "expired-child",
  argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
});
const outcome = Promise.allSettled([run.wait(), run.waitForExtinction!()]);
runWithProcessCleanupBudget({ deadline: performance.now(), warn() {} }, () => run.cancel());
const [, cleanup] = await outcome;
assert(cleanup.status === "rejected");
assert.match(cleanup.reason.message, /service child cleanup.*hard deadline/);
await release().catch(() => {});
trace("service-child-cleanup-deadline");

// mock-isolation: Keep the real Gateway runtime/broker and CLI signal owners;
// omit unrelated core services, as in server.spawn-broker.test.ts.
const serverUrl = pathToFileURL(path.resolve("src/gateway/server.ts")).href;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === serverUrl && specifier === "./server-start.js") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          export async function startGatewayServerCore() {
            Object.defineProperty(process, "platform", ${JSON.stringify(platform)});
            return {
              startupSettled: Promise.resolve(),
              getTailscaleIngressEndpoint() {},
              async close() {},
            };
          }
        `)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { startGatewayServer } = await import(serverUrl);
let starts = 0;
const code = await runGatewayLoop({
  ownsProcessLifecycle: true,
  onProcessResourcesSettled: (value) => trace(`custody:${value}`),
  start: async (options) => {
    trace(`start:${++starts}`);
    // Select Linux's broker lifetime on POSIX; command cleanup above uses the real OS.
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    const server = await startGatewayServer(0, options);
    hooks.deregister();
    setImmediate(() => trace("gateway-ready"));
    return server;
  },
});
trace(`loop-returned:${code}`);

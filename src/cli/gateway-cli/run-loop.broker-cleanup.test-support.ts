import { writeSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { runWithProcessCleanupBudget } from "../../process/supervisor/cleanup-budget.js";
import { getProcessSupervisor, shutdownProcessSupervisor } from "../../process/supervisor/index.js";
import { runGatewayLoop } from "./run-loop.js";

const trace = (line: string) => writeSync(1, `process proof: ${line}\n`);
const supervisor = getProcessSupervisor();
supervisor.acquireScopeCleanup("expired-child", { processTree: "required-all" });
const run = await supervisor.spawn({
  mode: "child",
  scopeKey: "expired-child",
  argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
});
// Keep the run live until shutdown joins it; historical failures are warning-only.
void Promise.allSettled([run.wait(), run.waitForExtinction!()]);
const closeKey = Symbol.for("openclaw.test.liveBrokerCleanup");
const fixtureGlobal = globalThis as typeof globalThis & { [closeKey]?: () => Promise<void> };
fixtureGlobal[closeKey] = async () => {
  try {
    await runWithProcessCleanupBudget({ deadline: performance.now(), warn() {} }, () =>
      shutdownProcessSupervisor(),
    );
  } catch (error) {
    trace("service-child-cleanup-deadline");
    throw error;
  }
};

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
            const close = globalThis[Symbol.for("openclaw.test.liveBrokerCleanup")];
            delete globalThis[Symbol.for("openclaw.test.liveBrokerCleanup")];
            return {
              startupSettled: Promise.resolve(),
              getTailscaleIngressEndpoint() {},
              close,
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

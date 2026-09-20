import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { getPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { startGatewayServerCore } from "../../gateway/server-start.js";
import { publishConfiguredModelRuntimeSnapshots } from "../../gateway/server-startup-model-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runGatewayLoop } from "./run-loop.js";

const root = process.argv[2]!;
const ignoresCancellation = process.argv[3] === "pending";
const trace = (message: string) => process.stdout.write(`process proof: ${message}\n`);
const entered = createDeferredCore();
const provider = "shutdown-acquisition";
const pluginRoot = path.join(root, "provider");
await fs.mkdir(pluginRoot, { recursive: true });
let acquisitions = 0;
Object.defineProperty(globalThis, "__shutdownAcquisition", {
  value: async (signal: AbortSignal) => {
    if (++acquisitions !== 2) {
      return;
    }
    const worker = new Worker("setInterval(() => {}, 1000)", { eval: true, execArgv: [] });
    const cancelled = createDeferredCore();
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    trace("acquisition-entered");
    entered.resolve();
    await cancelled.promise;
    trace("acquisition-cancelled");
    if (ignoresCancellation) {
      await new Promise(() => {});
    }
    await delay(100);
    await worker.terminate();
    trace("acquisition-joined");
  },
});
await fs.writeFile(
  path.join(pluginRoot, "package.json"),
  JSON.stringify({ name: provider, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
);
await fs.writeFile(
  path.join(pluginRoot, "openclaw.plugin.json"),
  JSON.stringify({
    id: provider,
    providers: [provider],
    providerCatalogEntry: "./catalog.cjs",
    configSchema: { type: "object", properties: {} },
  }),
);
await fs.writeFile(
  path.join(pluginRoot, "index.cjs"),
  `module.exports = { id: ${JSON.stringify(provider)}, register() {} };`,
);
await fs.writeFile(
  path.join(pluginRoot, "catalog.cjs"),
  `module.exports = { id: ${JSON.stringify(provider)}, label: "Shutdown fixture", auth: [],
    staticCatalog: { async run(ctx) {
      await globalThis.__shutdownAcquisition(ctx.signal);
      return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
        models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } };
    } } };`,
);
const config: OpenClawConfig = {
  agents: {
    defaults: { workspace: path.join(root, "workspace"), model: `${provider}/model` },
    entries: Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        index === 0 ? "main" : `agent-${index}`,
        { default: index === 0, workspace: path.join(root, `workspace-${index}`) },
      ]),
    ),
  },
  plugins: {
    allow: [provider],
    entries: { [provider]: { enabled: true } },
    load: { paths: [pluginRoot] },
    slots: { memory: "none" },
  },
  gateway: {
    auth: { mode: "token", token: "synthetic-shutdown-token" },
    controlUi: { enabled: false },
    reload: { mode: "off" },
  },
};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
await runGatewayLoop({
  ownsProcessLifecycle: true,
  start: async (startup) => {
    const server = await startGatewayServerCore(0, {
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
      ...startup,
    });
    await server.startupSettled;
    await import("../../agents/prepared-model-runtime.js");
    const api = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.preparedModelRuntimeTestApi")
    ] as { setModelRuntimeBuildTimeoutMsForTest(ms: number): void };
    // Reuse the existing startup-budget seam; shutdown clocks and owners remain real.
    api.setModelRuntimeBuildTimeoutMsForTest(100);
    await publishConfiguredModelRuntimeSnapshots({ cfg: config });
    await entered.promise;
    const status = getPreparedModelRuntimeStartupStatus();
    assert(status?.degraded && status.pendingAgents.includes("agent-1"));
    setImmediate(() => trace("gateway-ready-degraded"));
    return server;
  },
  runtime: {
    log: () => {},
    error: (...args) => console.error(...args),
    exit: (code) => {
      assert.notEqual(getPreparedModelRuntimeStartupStatus()?.degraded, false);
      trace(`process-exit:${code}`);
      process.exit(code);
    },
  },
});

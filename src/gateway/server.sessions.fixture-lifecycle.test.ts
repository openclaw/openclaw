import path from "node:path";
import { afterAll, test } from "vitest";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createGatewayFixtureFork } from "./server.fixture-lifetime.test-support.js";

const fixtureWorkers = createVitestWorkerRun(process.env, undefined, "runtime");
afterAll(() => fixtureWorkers.dispose());
try {
  await fixtureWorkers.prepare();
} catch (error) {
  await fixtureWorkers.dispose();
  throw error;
}
const runGatewayFixtureFork = createGatewayFixtureFork(fixtureWorkers, afterAll);

function retainedGatewayFixtureSource(repoRoot: string, root: string): string {
  const source = (file: string) => JSON.stringify(path.join(repoRoot, file));
  return `
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
const hooks = vi.hoisted(() => ({ setup: [], cleanup: [], reset: [], afterEach: [] }));
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal()),
  beforeAll: (fn) => hooks.setup.push(fn),
  afterAll: (fn) => hooks.cleanup.push(fn),
  beforeEach: (fn) => hooks.reset.push(fn),
  afterEach: (fn) => hooks.afterEach.push(fn),
}));
const { test, expect } = await vi.importActual("vitest");
fs.writeFileSync(${JSON.stringify(path.join(root, "worker.pid"))}, String(process.pid));
const sessions = await import(${source("src/gateway/test/server-sessions.test-helpers.ts")});
const gatewayHelpers = await import(${source("src/gateway/test-helpers.server.ts")});
const kernelModule = await import(${source("src/gateway/server-kernel.ts")});
const { createDeferredCore } = await import(${source("src/shared/deferred.ts")});
const takeHooks = () => Object.fromEntries(
  Object.entries(hooks).map(([name, callbacks]) => [name, callbacks.splice(0)]),
);
async function runHooks(callbacks) {
  const context = { signal: new AbortController().signal };
  for (const callback of callbacks) await callback(context);
}
const fault = new Error("synthetic received-connection cleanup failure");
function containsFault(error) {
  return error === fault || (error instanceof Error && (
    containsFault(error.cause) ||
    (error instanceof AggregateError && error.errors.some(containsFault))
  ));
}
async function expectRefusal(run, preserveFault = false) {
  await expect(run()).rejects.toSatisfy(error => !preserveFault || containsFault(error));
}

test("observes retained Gateway owners through fixture teardown", async () => {
  let kernel;
  const createKernel = kernelModule.createGatewayKernel;
  const factory = vi.spyOn(kernelModule, "createGatewayKernel").mockImplementation(async (...args) => {
    kernel = await createKernel(...args);
    return kernel;
  });
  const fixtureApi = sessions.setupGatewaySessionsTestHarness();
  const fixture = takeHooks();
  await runHooks(fixture.setup);
  await runHooks(fixture.reset);
  const harness = fixtureApi.getHarness();
  await harness.server.startupSettled;
  if (!kernel) throw new Error("expected the real Gateway kernel");
  const { dir } = await fixtureApi.createSessionStoreDir();
  const { ws } = await harness.openClient();
  const home = process.env.HOME;
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!home || !stateDir) throw new Error("expected isolated Gateway fixture selectors");
  // A changed synthetic selector makes the harness's earlier token snapshot observable.
  process.env.OPENCLAW_GATEWAY_TOKEN = "synthetic-retained-gateway-token";
  const selectors = new Map([
    "HOME", "USERPROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_AGENT_DIR", "OPENCLAW_GATEWAY_TOKEN",
  ].map(key => [key, process.env[key]]));
  const markers = { home: path.join(home, "owned.txt"), state: path.join(stateDir, "owned.txt"),
    sessions: path.join(dir, "owned.txt") };
  for (const file of Object.values(markers)) fs.writeFileSync(file, "owned");
  const readState = () => ({
    ...Object.fromEntries(Object.entries(markers).map(([name, file]) => {
      try { return [name, fs.readFileSync(file, "utf8") === "owned"]; }
      catch { return [name, false]; }
    })),
    selectorsIntact: [...selectors].every(([key, value]) => process.env[key] === value),
  });
  const retained = { home: true, state: true, sessions: true, selectorsIntact: true };
  const releaseProducer = createDeferredCore();
  let phase = "before-cleanup";
  const producer = releaseProducer.promise.then(() => {
    expect(readState()).toEqual(retained);
    expect(phase).toBe("after-cleanup");
    fs.writeFileSync(path.join(dir, "late-producer.txt"), "joined");
  });
  let stopCalls = 0;
  // This independent producer belongs to the generic owner, not the connection scope.
  kernel.registerGatewayLifetimeSidecars({ stop: async () => {
    stopCalls++;
    releaseProducer.resolve();
    await producer;
  } });
  let connectionCleanupFinished = false;
  const trackCleanup = kernel.connectionWork.trackCleanup.bind(kernel.connectionWork);
  vi.spyOn(kernel.connectionWork, "trackCleanup").mockImplementationOnce(run =>
    trackCleanup(async () => {
      await run();
      connectionCleanupFinished = true;
      throw fault;
    }),
  );
  try {
    await expectRefusal(() => harness.close(), true);
    expect(readState()).toEqual(retained);
    await expectRefusal(() => runHooks(fixture.afterEach));
    await expectRefusal(() => runHooks(fixture.reset));
    expect(readState()).toEqual(retained);
    await expectRefusal(() => runHooks(fixture.cleanup.toReversed()), true);
    await expectRefusal(() => runHooks(fixture.cleanup.toReversed()), true);
    expect(readState()).toEqual(retained);
    expect(fixtureApi.getHarness()).toBe(harness);
    phase = "after-cleanup";
    releaseProducer.resolve();
    await producer;
    expect(connectionCleanupFinished).toBe(true);
    expect(stopCalls).toBe(0);
    // Retained ownership must outlive the module that originally acquired the Gateway.
    vi.resetModules();
    const freshHelpers = await import(${source("src/gateway/test-helpers.server.ts")});
    freshHelpers.installGatewayTestHooks({ scope: "suite" });
    const successor = takeHooks();
    await expectRefusal(() => runHooks(successor.setup));
    expect(readState()).toEqual(retained);
  } finally {
    releaseProducer.resolve();
    try {
      await producer;
    } finally {
      ws.terminate();
      factory.mockRestore();
    }
    // No unpoison/reset escape hatch: native Vitest owns this disposable fork's exit.
  }
});
`;
}

test("retains fixture state and fences successors after a required Gateway close failure", (context) =>
  runGatewayFixtureFork(context, retainedGatewayFixtureSource));

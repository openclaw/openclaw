import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi, type TestContext } from "vitest";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { captureEnv } from "../test-utils/env.js";
import { createGatewayFixtureFork } from "./server.fixture-lifetime.test-support.js";

type FixtureHookContext = Pick<TestContext, "signal">;
type FixtureHook = (context: FixtureHookContext) => unknown;
const hooks = vi.hoisted(() => ({
  setup: [] as FixtureHook[],
  cleanup: [] as FixtureHook[],
}));
const caseHooks = vi.hoisted(() => ({
  setup: [] as FixtureHook[],
  cleanup: [] as FixtureHook[],
}));
const startupPreparation = vi.hoisted(() => ({
  held: false,
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));
// mock-isolation: Fake server acquisition owns this fixture; gate preparation without loading Gateway state.
vi.mock("./server-start.js", async () => {
  startupPreparation.entered.resolve();
  if (startupPreparation.held) {
    await startupPreparation.release.promise;
  }
  return {};
});
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest")>()),
  beforeAll: (fn: FixtureHook) => hooks.setup.push(fn),
  afterAll: (fn: FixtureHook) => hooks.cleanup.push(fn),
  beforeEach: (fn: FixtureHook) => caseHooks.setup.push(fn),
  afterEach: (fn: FixtureHook) => caseHooks.cleanup.push(fn),
  test: Object.assign(() => {}, { each: () => () => {} }),
}));
vi.mock("../agents/prepared-model-runtime.test-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.test-support.js")>()),
  resetPreparedModelCatalogStateForTest: async () => {},
}));

const listeners = vi.hoisted(() => new Set<import("node:net").Server>());
vi.mock("./server-runtime-state.js", () => ({
  createGatewayHttpTransport: async (params: { testListener?: import("node:http").Server }) => {
    if (!params.testListener) {
      throw new Error("Gateway fixture did not adopt its reserved listener");
    }
    return { httpServer: params.testListener };
  },
}));
vi.mock("./server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server.js")>()),
  startGatewayServer: async (port: number) => {
    const { createGatewayHttpTransport } = await import("./server-runtime-state.js");
    // The harness dispatcher injects its bound listener into this transport call.
    const { httpServer: listener } = await createGatewayHttpTransport({
      port,
    } as Parameters<typeof createGatewayHttpTransport>[0]);
    listeners.add(listener);
    return {
      startupSettled: Promise.resolve(),
      getTailscaleIngressEndpoint: () => undefined,
      close: async () => {
        if (listener.listening) {
          await new Promise<void>((resolve, reject) => {
            listener.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
    } satisfies import("./server.js").GatewayServer;
  },
}));

const { afterAll, afterEach, beforeEach, expect, test } =
  await vi.importActual<typeof import("vitest")>("vitest");
const takeHooks = (registered = hooks) => ({
  setup: registered.setup.splice(0),
  cleanup: registered.cleanup.splice(0),
});
await import("./server.sessions.create.worktrees.test.js");
const consumerHooks = takeHooks();
const sessions = await import("./test/server-sessions.test-helpers.js");
const serverHarness = await import("./server.e2e-ws-harness.js");
const gatewayHelpers = await import("./test-helpers.server.js");
const fixtureWorkers = createVitestWorkerRun();
afterAll(() => fixtureWorkers.dispose());
try {
  await fixtureWorkers.prepare();
} catch (error) {
  await fixtureWorkers.dispose();
  throw error;
}
const runGatewayFixtureFork = createGatewayFixtureFork(fixtureWorkers, afterAll);
const startHarness = serverHarness.startGatewayServerHarness;
let env: ReturnType<typeof captureEnv>;
beforeEach(() => {
  caseHooks.setup.length = 0;
  caseHooks.cleanup.length = 0;
  env = captureEnv([
    "HOME",
    "USERPROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
    "OPENCLAW_SKIP_GMAIL_WATCHER",
    "OPENCLAW_SKIP_CANVAS_HOST",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_PROVIDERS",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
  ]);
});
afterEach(async () => {
  // Preserve cleanup even on the unfixed side of these regressions.
  for (const listener of listeners) {
    if (listener.listening) {
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
      });
    }
  }
  listeners.clear();
  vi.restoreAllMocks();
  env.restore();
});

const uninterruptedContext: FixtureHookContext = { signal: new AbortController().signal };

async function setup(fixture: typeof hooks) {
  for (const hook of fixture.setup) {
    await hook(uninterruptedContext);
  }
}

async function cleanup(fixture: typeof hooks, context = uninterruptedContext) {
  for (const hook of fixture.cleanup.toReversed()) {
    await hook(context);
  }
}

// Red runs still release resources if the broken consumer aborts teardown.
async function emergencyCleanup(fixture: typeof hooks, context = uninterruptedContext) {
  for (const hook of fixture.cleanup.toReversed()) {
    await Promise.resolve()
      .then(() => hook(context))
      .catch(() => {});
  }
}

function interceptSessionDirectories(observe: (prefix: string, dir?: string) => void) {
  const mkdtemp = fs.mkdtemp.bind(fs);
  const mkdtempSync = fsSync.mkdtempSync.bind(fsSync);
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    observe(prefix);
    const dir = await mkdtemp(prefix, options);
    if (typeof dir === "string") {
      observe(prefix, dir);
    }
    return dir;
  });
  vi.spyOn(fsSync, "mkdtempSync").mockImplementation((prefix, options) => {
    observe(prefix);
    const dir = mkdtempSync(prefix, options);
    observe(prefix, dir);
    return dir;
  });
}

test("suite setup joins Gateway implementation preparation before releasing its home", async () => {
  startupPreparation.held = true;
  gatewayHelpers.installGatewayTestHooks({ scope: "suite" });
  const fixture = takeHooks();
  const pendingSetup = setup(fixture);
  let pendingCleanup: Promise<void> | undefined;
  try {
    await awaitGateBeforeSettlement(
      startupPreparation.entered.promise,
      pendingSetup,
      "fixture setup completed before Gateway implementation preparation",
    );
    const home = process.env.HOME!;
    expect(fsSync.existsSync(home)).toBe(true);
    pendingCleanup = cleanup(fixture);
    startupPreparation.release.resolve();
    await Promise.all([pendingSetup, pendingCleanup]);
    expect(fsSync.existsSync(home)).toBe(false);
  } finally {
    startupPreparation.held = false;
    startupPreparation.release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    await emergencyCleanup(fixture);
  }
});

test("shared setup failure skips consumer acquisition without adding an invalid-path error", async () => {
  const failure = new Error("injected shared setup failure");
  vi.spyOn(serverHarness, "startGatewayServerHarness").mockRejectedValue(failure);
  try {
    await expect(setup(consumerHooks)).rejects.toBe(failure);
    await expect(cleanup(consumerHooks)).resolves.toBeUndefined();
  } finally {
    await emergencyCleanup(consumerHooks);
  }
});

test("partial session setup closes its acquired server before removing its environment", async () => {
  sessions.setupGatewaySessionsTestHarness();
  const fixture = takeHooks();
  const failure = new Error("injected session directory acquisition failure");
  interceptSessionDirectories((prefix) => {
    if (prefix.includes("openclaw-sessions-")) {
      throw failure;
    }
  });
  let acquired: Awaited<ReturnType<typeof startHarness>> | undefined;
  let closeCalls = 0;
  vi.spyOn(serverHarness, "startGatewayServerHarness").mockImplementation(async () => {
    acquired = await startHarness();
    const home = process.env.HOME!;
    const closeHarness = acquired.close;
    acquired.close = async () => {
      closeCalls++;
      expect(process.env.HOME).toBe(home);
      expect(fsSync.existsSync(home)).toBe(true);
      await closeHarness();
    };
    return acquired;
  });
  try {
    await expect(setup(fixture)).rejects.toBe(failure);
    await cleanup(fixture);
    expect(closeCalls).toBe(1);
  } finally {
    if (acquired) {
      await acquired.server.close();
    }
    await emergencyCleanup(fixture);
  }
});

test("teardown joins delayed server acquisition before cleaning session directories and environment", async () => {
  sessions.setupGatewaySessionsTestHarness();
  const fixture = takeHooks();
  const acquired = createDeferredCore();
  const release = createDeferredCore();
  let server: Awaited<ReturnType<typeof startHarness>> | undefined;
  let closeCalls = 0;
  const roots = new Set<string>();
  interceptSessionDirectories((_prefix, dir) => {
    if (dir && path.basename(dir).startsWith("openclaw-sessions-")) {
      roots.add(dir);
    }
  });
  vi.spyOn(serverHarness, "startGatewayServerHarness").mockImplementation(async () => {
    server = await startHarness();
    const closeServer = server.close;
    server.close = async () => {
      closeCalls++;
      await closeServer();
    };
    acquired.resolve();
    await release.promise;
    return server;
  });
  const pendingSetup = setup(fixture);
  let pendingCleanup: Promise<void> | undefined;
  try {
    await Promise.race([acquired.promise, pendingSetup]);
    pendingCleanup = cleanup(fixture);
    release.resolve();
    await Promise.all([pendingSetup, pendingCleanup]);
    expect(closeCalls).toBe(1);
    expect([...listeners].every((listener) => !listener.listening)).toBe(true);
    expect(roots.size).toBe(1);
    expect([...roots].every((root) => !fsSync.existsSync(root))).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    await server?.close();
    await emergencyCleanup(fixture);
    for (const root of roots) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("teardown leaves delayed template initialization alive until its writes settle", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const mkdir = fs.mkdir.bind(fs);
  const rm = fs.rm.bind(fs);
  const rmSync = fsSync.rmSync.bind(fsSync);
  let templateRoot: string | undefined;
  let initializing = true;
  let removedDuringInitialization = false;
  const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (dir, options) => {
    if (
      String(dir).includes("openclaw-session-git-template-") &&
      path.basename(String(dir)) === "workspace"
    ) {
      templateRoot = path.dirname(String(dir));
      entered.resolve();
      await release.promise;
    }
    return await mkdir(dir, options);
  });
  const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (dir, options) => {
    if (String(dir) === templateRoot && initializing) {
      removedDuringInitialization = true;
    }
    return await rm(dir, options);
  });
  const rmSyncSpy = vi.spyOn(fsSync, "rmSync").mockImplementation((dir, options) => {
    if (String(dir) === templateRoot && initializing) {
      removedDuringInitialization = true;
    }
    rmSync(dir, options);
  });
  const pendingSetup = setup(consumerHooks).finally(() => {
    initializing = false;
  });
  let pendingCleanup: Promise<void> | undefined;
  try {
    await Promise.race([entered.promise, pendingSetup]);
    pendingCleanup = cleanup(consumerHooks);
    release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    expect(removedDuringInitialization).toBe(false);
    await expect(pendingSetup).resolves.toBeUndefined();
    await expect(pendingCleanup).resolves.toBeUndefined();
    expect(templateRoot).toBeDefined();
    expect(fsSync.existsSync(templateRoot!)).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    mkdirSpy.mockRestore();
    rmSpy.mockRestore();
    rmSyncSpy.mockRestore();
    await emergencyCleanup(consumerHooks);
    if (templateRoot) {
      await fs.rm(templateRoot, { recursive: true, force: true });
    }
  }
});

test("teardown joins pending home acquisition before restoring the environment", async () => {
  gatewayHelpers.installGatewayTestHooks({ scope: "suite" });
  const fixture = takeHooks();
  const homeBefore = process.env.HOME;
  const acquired = createDeferredCore();
  const release = createDeferredCore();
  const mkdtemp = fs.mkdtemp.bind(fs);
  let home: string | undefined;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    const dir = await mkdtemp(prefix, options);
    if (prefix.includes("openclaw-gateway-home-")) {
      home = dir;
      acquired.resolve();
      await release.promise;
    }
    return dir;
  });
  const pendingSetup = setup(fixture);
  let pendingCleanup: Promise<void> | undefined;
  try {
    await Promise.race([acquired.promise, pendingSetup]);
    pendingCleanup = cleanup(fixture);
    release.resolve();
    await Promise.all([pendingSetup, pendingCleanup]);
    expect(process.env.HOME).toBe(homeBefore);
    expect(fsSync.existsSync(home!)).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([pendingSetup, pendingCleanup]);
    await emergencyCleanup(fixture);
    if (home) {
      await fs.rm(home, { recursive: true, force: true });
    }
  }
});

test("a server cleanup error does not skip session directory or environment cleanup", async () => {
  const fixtureApi = sessions.setupGatewaySessionsTestHarness();
  const fixture = takeHooks();
  const homeBefore = process.env.HOME;
  const failure = new Error("injected server cleanup failure");
  let restoreClose: (() => void) | undefined;
  let database: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
  let memoryOwner: ReturnType<typeof memorySessionActorOwners.get> | undefined;
  try {
    await setup(fixture);
    const home = process.env.HOME!;
    const { dir } = await fixtureApi.createSessionStoreDir();
    database = openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(dir, "openclaw-agent.sqlite"),
    });
    memoryOwner = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    const server = fixtureApi.getHarness();
    const closeServer = server.close;
    const close = vi.spyOn(server, "close").mockImplementation(async () => {
      await closeServer();
      throw failure;
    });
    restoreClose = () => close.mockRestore();
    await expect(cleanup(fixture)).rejects.toBe(failure);
    expect(database.db.isOpen).toBe(false);
    expect(memorySessionActorOwners.read(memoryOwner)).toBeUndefined();
    expect(memoryOwner.assertCurrent).toThrow("closed");
    expect(fsSync.existsSync(dir)).toBe(false);
    expect(fsSync.existsSync(home)).toBe(false);
    expect(process.env.HOME).toBe(homeBefore);
  } finally {
    restoreClose?.();
    if (database) {
      closeOpenClawAgentDatabaseByPath(database.path);
    }
    if (memoryOwner) {
      memorySessionActorOwners.closeDatabase(memoryOwner);
    }
    await emergencyCleanup(fixture);
  }
});

test("skipped environment setup does not release an enclosing suite's home", async () => {
  gatewayHelpers.installGatewayTestHooks({ scope: "suite" });
  const parent = takeHooks();
  gatewayHelpers.installGatewayTestHooks({ scope: "suite" });
  const skipped = takeHooks();
  try {
    await setup(parent);
    const home = process.env.HOME!;
    await cleanup(skipped);
    expect(process.env.HOME).toBe(home);
    expect(fsSync.existsSync(home)).toBe(true);
  } finally {
    await emergencyCleanup(parent);
  }
});

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

test.each([
  { scope: "test", interrupted: false },
  { scope: "test", interrupted: true },
  { scope: "suite", interrupted: false },
  { scope: "suite", interrupted: true },
] as const)(
  "$scope teardown closes a late test-body startup and reports leaks (interrupted=$interrupted)",
  async ({ scope, interrupted }) => {
    gatewayHelpers.installGatewayTestHooks({ scope });
    const registered = scope === "suite" ? hooks : caseHooks;
    const fixture = takeHooks(registered);
    const suiteCase = scope === "suite" ? takeHooks(caseHooks) : undefined;
    const controller = new AbortController();
    const context: FixtureHookContext = { signal: controller.signal };
    const serverModule = await import("./server.js");
    const entered = createDeferredCore();
    const releaseStartup = createDeferredCore();
    const closeEntered = createDeferredCore();
    const releaseClose = createDeferredCore();
    const homeBefore = process.env.HOME;
    let closeCalls = 0;
    let home: string | undefined;
    const server = {
      startupSettled: Promise.resolve(),
      getTailscaleIngressEndpoint: () => undefined,
      close: async () => {
        closeCalls++;
        closeEntered.resolve();
        await releaseClose.promise;
        expect(process.env.HOME).toBe(home);
        expect(fsSync.existsSync(home!)).toBe(true);
      },
    } satisfies import("./server.js").GatewayServer;
    vi.spyOn(serverModule, "startGatewayServer").mockImplementation(async () => {
      entered.resolve();
      await releaseStartup.promise;
      return server;
    });
    const releaseClaim = vi.fn(async () => {});
    let starting: Promise<import("./server.js").GatewayServer> | undefined;
    let pendingCleanup: Promise<void> | undefined;
    try {
      await setup(fixture);
      if (suiteCase) {
        await setup(suiteCase);
      }
      home = process.env.HOME!;
      starting = gatewayHelpers.startTestGatewayServer({ port: 12345, release: releaseClaim });
      await awaitGateBeforeSettlement(entered.promise, starting, "startup settled before its gate");
      if (interrupted) {
        controller.abort(new Error("synthetic test interruption"));
      }
      pendingCleanup = (async () => {
        if (suiteCase) {
          await cleanup(suiteCase, context);
        }
        await cleanup(fixture, context);
      })();
      void pendingCleanup.catch(() => {});
      releaseStartup.resolve();
      await awaitGateBeforeSettlement(
        closeEntered.promise,
        pendingCleanup,
        "teardown released state before closing the acquired Gateway",
      );
      expect(process.env.HOME).toBe(home);
      expect(fsSync.existsSync(home)).toBe(true);
      releaseClose.resolve();
      await starting;
      if (interrupted) {
        await expect(pendingCleanup).resolves.toBeUndefined();
      } else {
        await expect(pendingCleanup).rejects.toThrow(
          `${scope} left a Gateway open; closed during teardown`,
        );
      }
      expect(closeCalls).toBe(1);
      expect(releaseClaim).toHaveBeenCalledTimes(1);
      expect(process.env.HOME).toBe(homeBefore);
      expect(fsSync.existsSync(home)).toBe(false);

      gatewayHelpers.installGatewayTestHooks({ scope: "suite" });
      const successor = takeHooks();
      try {
        await setup(successor);
        expect(fsSync.existsSync(process.env.HOME!)).toBe(true);
      } finally {
        await cleanup(successor);
      }
    } finally {
      releaseStartup.resolve();
      releaseClose.resolve();
      await Promise.allSettled([starting, pendingCleanup]);
      if (starting) {
        await (await starting).close();
      }
      await emergencyCleanup(fixture, context);
    }
  },
);

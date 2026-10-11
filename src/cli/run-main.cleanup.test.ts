import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

const dispatch = vi.hoisted(() => ({
  run: async () => {},
  command: undefined as Promise<void> | undefined,
  memoryClosed: vi.fn(async () => {}),
  startProxy: vi.fn<() => Promise<ProxyHandle | null>>(async () => null),
  stopProxy: vi.fn(async (handle: ProxyHandle) => handle.stop()),
}));
const temp = useAutoCleanupTempDirTracker(afterEach);
const installUnhandledRejectionHandlerMock = vi.hoisted(() => vi.fn());
// Only bootstrap/dispatch are replaced; process entry, registry scopes and cleanup are real.
vi.mock("./route.js", () => ({
  tryRouteCli: async () => {
    await dispatch.run();
    return true;
  },
}));
vi.mock("../infra/is-main.js", () => ({ isMainModule: () => true }));
vi.mock("../entry.esm-resolve-fast-path.js", () => ({ installDistEsmResolveFastPath() {} }));
vi.mock("../entry.version-fast-path.js", () => ({ tryHandleRootVersionFastPath: () => false }));
vi.mock("../entry.compile-cache.js", () => ({
  resolveEntryInstallRoot: () => process.cwd(),
  enableOpenClawCompileCache() {},
  respawnWithoutOpenClawCompileCacheIfNeeded: async () => false,
}));
vi.mock("../entry.respawn.js", () => ({ buildCliRespawnPlan: () => null }));
vi.mock("../infra/openclaw-exec-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-exec-env.js")>()),
  ensureOpenClawExecMarkerOnProcess() {},
}));
vi.mock("../infra/warning-filter.js", () => ({ installProcessWarningFilter() {} }));
vi.mock("../infra/unhandled-rejections.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/unhandled-rejections.js")>()),
  installUnhandledRejectionHandler: installUnhandledRejectionHandlerMock,
}));
vi.mock("../logging/console.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/console.js")>()),
  enableConsoleCapture() {},
  routeLogsToStderr() {},
}));
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath() {} }));
vi.mock("./dotenv.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dotenv.js")>()),
  loadCliDotEnv() {},
}));
vi.mock("../config/io.js", () => ({ readBestEffortConfig: async () => ({}) }));
// mock-isolation: Synthetic proxy handles exercise CLI custody without changing process-wide routing or starting Proxyline.
vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: dispatch.startProxy,
  stopProxy: dispatch.stopProxy,
}));
vi.mock("../plugins/memory-state.js", () => ({ hasMemoryRuntime: () => true }));
vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagersCore: dispatch.memoryClosed,
}));
vi.mock("./gateway-cli/pre-bootstrap.js", () => ({ selectGatewayRunEnvironment: async () => {} }));
vi.mock("./gateway-cli/run-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-cli/run-command.js")>()),
  addGatewayRunCommand: (command: import("commander").Command) =>
    command.action(() => dispatch.run()),
}));
vi.mock("./command-execution-startup.js", () => ({ ensureCliExecutionBootstrap: async () => {} }));
vi.mock("./banner.js", () => ({ emitCliBanner() {} }));
vi.mock("./one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput() {},
  runCliWithExitFinalization: ({ run }: { run: () => Promise<void> }) => {
    dispatch.command = run();
    void dispatch.command.catch(() => {});
    return dispatch.command;
  },
}));

function resourceHarness(id: string) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed: Promise<unknown[]> | undefined;
  let output: readline.Interface | undefined;
  let disposeCalls = 0;
  const pending = new Map<string, Deferred>();
  function line(value: string) {
    const next = createDeferredCore();
    pending.set(value, next);
    return next.promise;
  }
  const harness: AgentHarness = {
    id,
    label: id,
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("catalog-only fixture");
    },
    loadModelCatalog: async () => {
      const ready = line("ready");
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import readline from "node:readline";
        const lines = readline.createInterface({ input: process.stdin });
        lines.on("line", () => process.stdout.write("pong\\n"));
        lines.on("close", () => process.stdout.end("stdin-end\\n"));
        process.stdout.write("ready\\n");
      `,
        ],
        { env: {}, stdio: ["pipe", "pipe", "pipe"] },
      );
      closed = once(child, "close");
      output = readline.createInterface({ input: child.stdout });
      output.on("line", (value) => pending.get(value)?.resolve());
      await ready;
      return [];
    },
    dispose: async () => {
      disposeCalls++;
      child?.stdin.end();
      await closed;
    },
  };
  return {
    harness,
    async ping() {
      const pong = line("pong");
      child?.stdin.write("ping\n");
      await pong;
    },
    snapshot: () => ({ disposeCalls, exitCode: child?.exitCode, signalCode: child?.signalCode }),
    async closeAndJoin() {
      // Setup can fail before spawn; teardown must preserve that original error.
      if (!child) {
        return;
      }
      child.stdin.end();
      await closed;
      output?.close();
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBe(null);
    },
  };
}

const argv = [
  "node",
  "openclaw",
  "onboard",
  "--non-interactive",
  "--accept-risk",
  "--flow",
  "import",
];
let registryApi: typeof import("../agents/harness/registry.js");
let runtime: typeof import("../plugins/runtime.js");
let scopes: typeof import("../plugins/runtime/gateway-request-scope.js");
let emptyRegistry: typeof import("../plugins/registry-empty.js");
let originalRegistrySnapshot: ReturnType<typeof runtime.captureActivePluginRegistrySnapshot>;
let originalArgv: string[];
let originalTitle: string;
let originalListeners: ReturnType<typeof process.listeners>;

beforeEach(async () => {
  vi.resetModules();
  registryApi = await import("../agents/harness/registry.js");
  runtime = await import("../plugins/runtime.js");
  scopes = await import("../plugins/runtime/gateway-request-scope.js");
  emptyRegistry = await import("../plugins/registry-empty.js");
  originalRegistrySnapshot = runtime.captureActivePluginRegistrySnapshot();
  originalArgv = process.argv;
  originalTitle = process.title;
  originalListeners = process.listeners("uncaughtException");
  process.argv = argv;
  runtime.setActivePluginRegistry(emptyRegistry.createEmptyPluginRegistry());
  dispatch.command = undefined;
  dispatch.run = async () => {};
  dispatch.memoryClosed.mockClear();
  dispatch.startProxy.mockReset().mockResolvedValue(null);
  dispatch.stopProxy.mockClear();
  installUnhandledRejectionHandlerMock.mockClear();
});
afterEach(() => {
  process.argv = originalArgv;
  process.title = originalTitle;
  runtime.restoreActivePluginRegistrySnapshot(originalRegistrySnapshot);
  for (const listener of process.listeners("uncaughtException")) {
    if (!originalListeners.includes(listener)) {
      process.off("uncaughtException", listener);
    }
  }
});

function registerHarness(registry: PluginRegistry, harness: AgentHarness) {
  runtime.withPluginRegistrationContext(registry, "fixture", () =>
    registryApi.registerAgentHarness(harness),
  );
}

async function acquire(id: string) {
  await registryApi.getRegisteredAgentHarness(id)!.harness.loadModelCatalog!({
    config: {},
    agentId: "test",
    agentDir: process.cwd(),
    workspaceDir: process.cwd(),
  });
}
async function runProcessEntry() {
  await import("../index.js");
  await dispatch.command;
}

describe("CLI process harness cleanup", () => {
  it("reclaims earlier CLI captures and owns periodic cleanup until command exit", async () => {
    const stateDir = temp.make("cli-capture-orphans-");
    const source = path.join(stateDir, "fixture");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = 'retained';");
    const { acquireSqliteStagingToken } = await import("../infra/sqlite-staging-token.js");
    const prior = path.join(stateDir, "tmp", "plugin-captures", "previous-command");
    fs.mkdirSync(path.join(prior, "captures"), { recursive: true });
    fs.writeFileSync(path.join(prior, "captures", "source.js"), "retained source");
    const release = acquireSqliteStagingToken(prior, "create");
    release();
    const aged = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(prior, aged, aged);
    const { getBoundLegacyPluginSdkResourceHost } =
      await import("../plugins/legacy-sdk-resource-host.js");
    const { getPluginCache } = await import("../plugins/plugin-cache.js");
    const { PluginInstance } = await import("../plugins/plugin-instance.js");
    const { capturePluginGenerationArtifact } =
      await import("../plugins/plugin-generation-artifact.js");
    // Fixture imports initialize WAL maintenance before we observe the command scheduler.
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const schedulerModule = await import("../infra/gateway-scheduler.js");
    const constructor = vi
      .spyOn(schedulerModule, "GatewayScheduler")
      .mockImplementation(function () {
        return scheduler;
      });
    let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
    dispatch.run = async () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const host = getBoundLegacyPluginSdkResourceHost();
      expect(host).toBeDefined();
      expect(host?.scheduler).toBe(scheduler);
      artifact = capturePluginGenerationArtifact(source);
      const instance = new PluginInstance("orphan-recovery-fixture");
      instance.onModuleDispose(artifact.disposeAsync);
      getPluginCache().instances.add(instance);
      expect(scheduler.nextWakeAtMs).toBe(clock.clock.now() + 60 * 60_000);
      expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toContain(
        "retained",
      );
    };
    try {
      await runProcessEntry();
      // Other CLI suites can initialize an unrelated scheduler in the same hosted
      // worker. This test owns the injected scheduler's lifecycle, not the global
      // constructor count.
      expect(constructor).toHaveBeenCalled();
      expect(fs.existsSync(prior)).toBe(false);
      expect(scheduler.signal.aborted).toBe(true);
      expect(scheduler.nextWakeAtMs).toBeNull();
      expect(artifact).toBeDefined();
      expect(fs.existsSync(artifact!.boundaryRoot)).toBe(false);
    } finally {
      constructor.mockRestore();
      await scheduler.stop();
      await artifact?.disposeAsync();
      vi.unstubAllEnvs();
    }
  });

  it.each(["failure", "gateway-adopted"])(
    "retires command captures unless their inventory is adopted (%s)",
    async (mode) => {
      const stateDir = temp.make("cli-capture-custody-");
      const source = path.join(stateDir, "fixture");
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = 'retained';");
      const { getPluginCache, adoptProcessPluginCache, getProcessPluginCache } =
        await import("../plugins/plugin-cache.js");
      const { PluginInstance } = await import("../plugins/plugin-instance.js");
      const { capturePluginGenerationArtifact } =
        await import("../plugins/plugin-generation-artifact.js");
      const { retainGatewayPluginMetadata } =
        await import("../plugins/plugin-metadata-lifecycle.js");
      const previous = getProcessPluginCache();
      let gateway: ReturnType<typeof retainGatewayPluginMetadata> | undefined;
      let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
      const failure = new Error("fixture command failed");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      dispatch.run = async () => {
        const cache = getPluginCache();
        artifact = capturePluginGenerationArtifact(source);
        const instance = new PluginInstance("capture-fixture");
        instance.onModuleDispose(artifact.disposeAsync);
        cache.instances.add(instance);
        if (mode === "gateway-adopted") {
          gateway = retainGatewayPluginMetadata(createTestGatewayScheduler());
          adoptProcessPluginCache(cache);
          gateway.publish(undefined);
        }
        if (mode === "failure") {
          throw failure;
        }
      };
      try {
        const error = await runProcessEntry().catch((cause: unknown) => cause);
        expect(error).toBe(mode === "failure" ? failure : undefined);
        expect(artifact).toBeDefined();
        expect(fs.existsSync(artifact!.boundaryRoot)).toBe(mode === "gateway-adopted");
        if (gateway) {
          expect(fs.readFileSync(artifact!.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
            "module.exports = 'retained';",
          );
          await gateway.close();
          expect(fs.existsSync(artifact!.boundaryRoot)).toBe(false);
        }
      } finally {
        await gateway?.close();
        await artifact?.disposeAsync();
        adoptProcessPluginCache(previous);
        vi.unstubAllEnvs();
      }
    },
  );

  it("installs the rejection handler before the direct Gateway fast path", async () => {
    dispatch.run = async () => {
      expect(installUnhandledRejectionHandlerMock).toHaveBeenCalledOnce();
    };

    const { runCli } = await import("./run-main.js");
    await runCli(["node", "openclaw", "gateway"]);

    expect(installUnhandledRejectionHandlerMock).toHaveBeenCalledOnce();
  });

  it.each([undefined, "drained", "retained"] as const)(
    "uses the actual Gateway cleanup receipt (%s), not its command name",
    async (receipt) => {
      const { getGatewayRunRuntimeHooks } = await import("./gateway-cli/runtime-hooks.js");
      const { runCli } = await import("./run-main.js");
      dispatch.run = async () => {
        if (receipt) {
          getGatewayRunRuntimeHooks().onProcessResourcesSettled?.(receipt);
        }
      };
      await runCli(["node", "openclaw", "gateway"]);
      expect(dispatch.memoryClosed).toHaveBeenCalledTimes(receipt ? 0 : 1);
    },
  );

  it("joins cancelled command work before signal finalizers", async () => {
    const { withCliProcessScope } = await import("./runtime-cleanup-scope.js");
    const { getAsyncWorkSignal } = await import("../shared/async-work-scope.js");
    const { exitAfterSignalExitBarriers, registerSignalExitFinalizer, waitForCliSignalExit } =
      await import("./signal-exit-barrier.js");
    const { runCli } = await import("./run-main.js");
    const entered = createDeferredCore();
    const cancelled = createDeferredCore();
    const finish = createDeferredCore();
    let commandFinished = false;
    dispatch.run = async () => {
      const signal = getAsyncWorkSignal();
      expect(signal).toBeDefined();
      signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
      entered.resolve();
      await finish.promise;
      commandFinished = true;
    };
    const finalize = vi.fn(async () => {
      expect(commandFinished).toBe(true);
      expect(dispatch.memoryClosed).toHaveBeenCalledOnce();
    });
    const unregister = registerSignalExitFinalizer(finalize);
    const previousExitCode = process.exitCode;
    const command = withCliProcessScope(() => runCli(argv));
    try {
      await entered.promise;
      exitAfterSignalExitBarriers(143);
      await cancelled.promise;
      expect(finalize).not.toHaveBeenCalled();
      expect(dispatch.memoryClosed).not.toHaveBeenCalled();
      finish.resolve();
      await command;
      expect(await waitForCliSignalExit()).toBe(143);
      expect(finalize).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await command;
      await waitForCliSignalExit();
      unregister();
      process.exitCode = previousExitCode;
    }
  });

  it.each(["return", "throw", "SIGTERM", "SIGINT"] as const)(
    "joins admitted command tails before stopping their managed proxy (%s)",
    async (mode) => {
      const { withCliProcessScope, getCliPluginInvocationResources } =
        await import("./runtime-cleanup-scope.js");
      const { getAsyncWorkSignal, trackAsyncWork } = await import("../shared/async-work-scope.js");
      const { exitAfterSignalExitBarriers, waitForCliSignalExit } =
        await import("./signal-exit-barrier.js");
      const { runCli } = await import("./run-main.js");
      const entered = createDeferredCore();
      const cancelled = createDeferredCore();
      const settling = createDeferredCore();
      const finish = createDeferredCore();
      const failure = new Error("command failed with an admitted proxy tail");
      const signalCode = mode === "SIGTERM" ? 143 : mode === "SIGINT" ? 130 : undefined;
      const previousExitCode = process.exitCode;
      let proxyAlive = true;
      let tailFinished = false;
      let tailObservedProxy: boolean | undefined;
      let tail: Promise<void> | undefined;
      let restoreSettlementObserver: (() => void) | undefined;
      const proxy: ProxyHandle = {
        proxyUrl: "http://127.0.0.1:19876",
        stop: vi.fn(async () => {
          proxyAlive = false;
        }),
        kill: vi.fn(),
      };
      dispatch.startProxy.mockResolvedValueOnce(proxy);
      dispatch.run = async () => {
        const resources = getCliPluginInvocationResources()!;
        const settleWork = resources.settleWork.bind(resources);
        const observer = vi.spyOn(resources, "settleWork").mockImplementation(() => {
          const pending = settleWork();
          settling.resolve();
          return pending;
        });
        restoreSettlementObserver = () => observer.mockRestore();
        const signal = getAsyncWorkSignal()!;
        tail = trackAsyncWork(async () => {
          signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
          await finish.promise;
          tailObservedProxy = proxyAlive;
          tailFinished = true;
        });
        entered.resolve();
        if (signalCode !== undefined) {
          await cancelled.promise;
        }
        if (mode === "throw") {
          throw failure;
        }
      };
      const command = withCliProcessScope(() => runCli(argv));
      const outcome = command.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await awaitGateBeforeSettlement(entered.promise, outcome, "command never dispatched");
        if (signalCode !== undefined) {
          exitAfterSignalExitBarriers(signalCode);
        }
        await awaitGateBeforeSettlement(settling.promise, outcome, "command skipped its work join");
        expect(tailFinished).toBe(false);
        expect(proxyAlive).toBe(true);
        expect(dispatch.stopProxy).not.toHaveBeenCalled();
        expect(dispatch.memoryClosed).not.toHaveBeenCalled();
        finish.resolve();
        expect(await outcome).toBe(mode === "throw" ? failure : undefined);
        await tail;
        expect(tailObservedProxy).toBe(true);
        expect(tailFinished).toBe(true);
        expect(dispatch.stopProxy).toHaveBeenCalledExactlyOnceWith(proxy);
        expect(proxy.stop).toHaveBeenCalledOnce();
        expect(proxy.kill).not.toHaveBeenCalled();
        expect(proxyAlive).toBe(false);
        expect(dispatch.memoryClosed).toHaveBeenCalledOnce();
        expect(dispatch.stopProxy).toHaveBeenCalledBefore(dispatch.memoryClosed);
        if (signalCode !== undefined) {
          expect(await waitForCliSignalExit()).toBe(signalCode);
        }
      } finally {
        finish.resolve();
        await outcome;
        await tail;
        await waitForCliSignalExit();
        restoreSettlementObserver?.();
        process.exitCode = previousExitCode;
      }
    },
  );

  it("awaits a transient disposer before later finalizers and process completion", async () => {
    const registry = emptyRegistry.createEmptyPluginRegistry();
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    const resource = resourceHarness("awaited");
    const dispose = resource.harness.dispose!.bind(resource.harness);
    resource.harness.dispose = async () => {
      entered.resolve();
      await gate.promise;
      await dispose();
    };
    registerHarness(registry, resource.harness);
    dispatch.run = () => scopes.withPluginRuntimeRegistryScope(registry, () => acquire("awaited"));
    let returned = false;
    const command = runProcessEntry().then(() => {
      returned = true;
    });
    try {
      // Early command return must fail the assertion and still reach fixture teardown.
      await Promise.race([entered.promise, command]);
      expect(returned).toBe(false);
      await resource.ping();
      expect(returned).toBe(false);
      expect(dispatch.memoryClosed).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      try {
        await command;
      } finally {
        await resource.closeAndJoin();
      }
    }
    expect(dispatch.memoryClosed).toHaveBeenCalledOnce();
  });

  it("retains transient cleanup from the primary executable bootstrap", async () => {
    const registry = emptyRegistry.createEmptyPluginRegistry();
    const resource = resourceHarness("primary-entry");
    registerHarness(registry, resource.harness);
    dispatch.run = () =>
      scopes.withPluginRuntimeRegistryScope(registry, () => acquire("primary-entry"));
    try {
      await import("../entry.js");
      await dispatch.command;
      expect(resource.snapshot()).toEqual({ disposeCalls: 1, exitCode: 0, signalCode: null });
    } finally {
      await resource.closeAndJoin();
    }
  });

  it.each(["direct", "gateway-legacy"])(
    "leaves %s transient resources with their owner",
    async (mode) => {
      const registry = emptyRegistry.createEmptyPluginRegistry();
      const resource = resourceHarness("borrowed");
      registerHarness(registry, resource.harness);
      dispatch.run = () =>
        scopes.withPluginRuntimeRegistryScope(registry, () => acquire("borrowed"));
      try {
        if (mode === "direct") {
          const { runCli } = await import("./run-main.js");
          await runCli(argv);
        } else {
          const borrowedAction = dispatch.run;
          dispatch.run = async () => {
            dispatch.run = borrowedAction;
            const { runLegacyCliEntry } = await import("../index.js");
            await runLegacyCliEntry(argv, undefined, {
              retainConsoleRoutingUntilProcessExit: true,
            });
          };
          process.argv = ["node", "openclaw", "gateway"];
          await runProcessEntry();
        }
        expect(resource.snapshot()).toEqual({ disposeCalls: 0, exitCode: null, signalCode: null });
        await resource.ping();
        const { isPluginRegistryRetired } = await import("../plugins/registry-lifecycle.js");
        expect(isPluginRegistryRetired(registry)).toBe(false);
      } finally {
        await scopes.withPluginRuntimeRegistryScope(
          registry,
          registryApi.disposeRegisteredAgentHarnesses,
        );
        await resource.closeAndJoin();
      }
      expect(resource.snapshot().disposeCalls).toBe(1);
    },
  );

  it("deduplicates exact instances, preserves their first disposal context and continues after errors", async () => {
    const registry = emptyRegistry.createEmptyPluginRegistry();
    const second = emptyRegistry.createEmptyPluginRegistry();
    const resources = [resourceHarness("shared"), resourceHarness("shared")];
    const order: string[] = [];
    const contexts: unknown[] = [];
    for (const [index, target] of [registry, second].entries()) {
      const resource = resources[index]!;
      const dispose = resource.harness.dispose!.bind(resource.harness);
      resource.harness.dispose = async function () {
        contexts.push([
          this,
          runtime.getPluginRegistryForContext(),
          scopes.getPluginRuntimeGatewayRequestScope()?.pluginId,
        ]);
        order.push(`dispose-${index}`);
        await dispose();
        contexts.push(runtime.getPluginRegistryForContext());
        if (index === 0) {
          throw new Error("synthetic disposer failure");
        }
      };
      registerHarness(target, resource.harness);
    }
    // The same exact registration can also be visible from the current registry.
    runtime.getActivePluginRegistry()!.agentHarnesses.push(registry.agentHarnesses[0]!);
    dispatch.run = async () => {
      for (const [index, target] of [registry, second].entries()) {
        await scopes.withPluginRuntimeRegistryScope(target, () =>
          scopes.withPluginRuntimePluginScope({ pluginId: `request-${index}` }, async () => {
            await acquire("shared");
            registryApi.getRegisteredAgentHarness("shared");
            registryApi.listRegisteredAgentHarnesses();
          }),
        );
      }
    };
    try {
      await runProcessEntry();
      expect(order).toEqual(["dispose-0", "dispose-1"]);
      expect(contexts.slice(0, 2)).toEqual([
        [registry.agentHarnesses[0]!.harness, registry, "request-0"],
        [second.agentHarnesses[0]!.harness, second, "request-1"],
      ]);
      expect(contexts.slice(2)).toEqual(expect.arrayContaining([registry, second]));
      expect(resources.map((resource) => resource.snapshot().disposeCalls)).toEqual([1, 1]);
      expect(dispatch.memoryClosed).toHaveBeenCalledOnce();
    } finally {
      await Promise.all(resources.map((resource) => resource.closeAndJoin()));
    }
  });

  it("rejects reuse of cleaned registrations without retiring unused cache entries", async () => {
    const { getPluginLoaderCacheState } = await import("../plugins/registry-lifecycle.js");
    const cache = getPluginLoaderCacheState();
    const unused = emptyRegistry.createEmptyPluginRegistry();
    cache.set("cleanup-unused", unused);
    const { withCliProcessScope } = await import("./runtime-cleanup-scope.js");
    const { runCli } = await import("./run-main.js");
    for (let invocation = 0; invocation < 2; invocation++) {
      const registry = emptyRegistry.createEmptyPluginRegistry();
      const resource = resourceHarness("sequential");
      registerHarness(registry, resource.harness);
      cache.set("cleanup-used", registry);
      let retainedLookup:
        | (() => ReturnType<typeof registryApi.getRegisteredAgentHarness>)
        | undefined;
      dispatch.run = () =>
        scopes.withPluginRuntimeRegistryScope(registry, async () => {
          await acquire("sequential");
          retainedLookup = AsyncLocalStorage.bind(() =>
            registryApi.getRegisteredAgentHarness("sequential"),
          );
        });
      try {
        await withCliProcessScope(() => runCli(argv));
        expect(cache.get("cleanup-used")).toBeUndefined();
        expect(cache.get("cleanup-unused")).toBe(unused);
        expect(resource.snapshot()).toEqual({ disposeCalls: 1, exitCode: 0, signalCode: null });
        expect(retainedLookup).toBeDefined();
        expect(retainedLookup!()).toBeUndefined();
      } finally {
        await resource.closeAndJoin();
      }
    }
  });
});

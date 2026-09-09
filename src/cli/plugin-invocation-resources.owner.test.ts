import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { resolvePluginProviders } from "openclaw/plugin-sdk/provider-catalog-runtime";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { getRegisteredAgentHarness, registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { registerPluginCliCommands } from "../plugins/cli.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { acquirePluginRegistryForInspection } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { withPluginRegistrationContext } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { CliPluginInvocationResources } from "./plugin-invocation-resources.js";
import { registerCommandGroups } from "./program/register-command-groups.js";
import {
  getCliPluginInvocationResources,
  withCliCommandCleanup,
  withCliProcessScope,
} from "./runtime-cleanup-scope.js";
import { closeCliResources, getPendingCliDisposers } from "./runtime-cleanup.js";

const fixtureCleanups: Array<() => void> = [];
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
let sequence = 0;

function nativeFixture(
  options: {
    disposalFailure?: boolean;
    capturedDisposal?: "async-context" | "work-tracker";
    queuedAbortCleanup?: boolean;
    sdkProvider?: boolean;
  } = {},
) {
  const id = `cli-owned-native-${sequence++}`;
  const key = `__${id}`;
  const state = {
    database: undefined as DatabaseSync | undefined,
    disposals: 0,
    entered: createDeferredCore(),
    resume: createDeferredCore(),
    afterCleanup: undefined as unknown,
    disposalRead: undefined as unknown,
    trackAsyncWork,
    captureAsyncWorkTracker,
    getAsyncWorkSignal,
    abortCleanup: undefined as Promise<void> | undefined,
    abortRead: undefined as unknown,
  };
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const plugin = writePlugin({
    id,
    filename: "index.cjs",
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  if (api.registrationMode === "cli-metadata") throw new Error("Use the inert metadata entry");
  const state = globalThis[${JSON.stringify(key)}];
  const database = state.database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE observations (value INTEGER)");
  const closeResource = () => {
    state.disposals++;
    database.close();
    if (${options.disposalFailure === true}) throw new Error("synthetic disposal failure");
  };
  const cooperatingCleanup = async () => {
    await Promise.resolve();
    state.disposalRead = database.prepare("SELECT 42 AS value").get();
    closeResource();
  };
  const captureMode = ${JSON.stringify(options.capturedDisposal)};
  const track = state.captureAsyncWorkTracker();
  if (${options.queuedAbortCleanup === true}) {
    state.getAsyncWorkSignal().addEventListener("abort", () => queueMicrotask(() => {
      state.abortCleanup = track(async () => {
        await require("node:fs/promises").readFile(__filename);
        state.abortRead = database.prepare("SELECT 42 AS value").get();
      });
      void state.abortCleanup.catch(() => {});
    }), { once: true });
  }
  const dispose = captureMode === "async-context"
    ? require("node:async_hooks").AsyncLocalStorage.bind(() => state.trackAsyncWork(cooperatingCleanup))
    : captureMode === "work-tracker" ? () => track(cooperatingCleanup) : closeResource;
  api.registerRuntimeLifecycle({ id: "native", dispose });
  if (${options.sdkProvider === true}) api.registerProvider({
    id: ${JSON.stringify(id)}, label: "CLI SDK provider", auth: [],
    isCacheTtlEligible: () => database.prepare("SELECT 42 AS value").get().value === 42,
  });
  api.registerCli(async ({ program }) => {
    state.entered.resolve();
    await state.resume.promise;
    database.prepare("INSERT INTO observations VALUES (?)").run(42);
    program.command("native").action(() => {
      state.afterCleanup = database.prepare("SELECT value FROM observations").get();
    });
  }, { descriptors: [{name: "native", description: "Native", hasSubcommands: false}] });
} };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "cli-metadata.cjs"),
    `module.exports = {
    id: ${JSON.stringify(id)}, register(api) {
      api.registerCli(() => {}, { descriptors: [{name: "native", description: "Native", hasSubcommands: false}] });
    }
  };`,
  );
  if (options.sdkProvider) {
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        providers: [id],
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
  }
  const config = { plugins: { allow: [id], load: { paths: [plugin.dir] } } };
  const env = {
    HOME: plugin.dir,
    OPENCLAW_STATE_DIR: `${plugin.dir}/state`,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const fixture = {
    id,
    key,
    state,
    config,
    env,
    load: async () => {
      const acquisition = await acquirePluginRegistryForInspection({
        config,
        env,
        logger: quietLogger,
      });
      try {
        expect(
          acquisition.registry.plugins,
          JSON.stringify(acquisition.registry.diagnostics),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id, source: plugin.file, status: "loaded" }),
          ]),
        );
        expect(state.database).toBeDefined();
        return acquisition;
      } catch (error) {
        await acquisition.release().catch(() => {});
        throw error;
      }
    },
  };
  fixtureCleanups.push(() => {
    state.resume.resolve();
    if (state.database?.isOpen) {
      state.database.close();
    }
    Reflect.deleteProperty(globalThis, key);
  });
  return fixture;
}

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) {
    cleanup();
  }
  resetPluginLoaderTestStateForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("joins the shipped eager registrar's real promise before releasing its native resource", async () => {
  const fixture = nativeFixture();
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, async () => {
      const resources = getCliPluginInvocationResources()!;
      const registry = await resources.acquire(fixture.load);
      const program = new Command();
      const registered = registerCommandGroups(
        program,
        [
          {
            placeholders: [{ name: "native", description: "Native" }],
            register: (target) =>
              registry.cliRegistrars[0]!.register({
                program: target,
                parentPath: [],
                config: fixture.config,
                logger: quietLogger,
              }),
          },
        ],
        { eager: true, primary: null, registerPrimaryOnly: false },
      );
      expect(registered).toBeUndefined();
      await fixture.state.entered.promise;
      let released = false;
      const closing = resources.release().then(() => {
        released = true;
      });
      try {
        await expect(resources.run(() => undefined)).rejects.toThrow("invocation is closed");
        expect(released).toBe(false);
        expect(fixture.state.database!.isOpen).toBe(true);
      } finally {
        fixture.state.resume.resolve();
        await closing;
      }
      expect(program.commands.map((command) => command.name())).toEqual(["native"]);
      expect(fixture.state.disposals).toBe(1);
      expect(fixture.state.database!.isOpen).toBe(false);
    }),
  );
});

it("releases an acquisition that finishes after admission closes", async () => {
  const fixture = nativeFixture();
  const resources = new CliPluginInvocationResources();
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const loading = resources.acquire(async () => {
    const acquisition = await fixture.load();
    entered.resolve();
    await resume.promise;
    return acquisition;
  });
  await Promise.race([entered.promise, loading]);
  const rejected = expect(loading).rejects.toThrow("closed during registry acquisition");
  const closing = resources.release();
  expect(fixture.state.database!.isOpen).toBe(true);
  resume.resolve();
  await rejected;
  await closing;
  expect(fixture.state.disposals).toBe(1);
});

it("retains CLI SDK providers through their actual local Gateway context", async () => {
  const { withLocalGatewayRequestScope } = await import("../gateway/local-request-context.js");
  const { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  const state = await createOpenClawTestState({ label: "cli-sdk-local-context" });
  const fixture = nativeFixture({ sdkProvider: true });
  const foreign = new LegacyPluginSdkResourceHost();
  try {
    await withCliProcessScope(() =>
      withCliCommandCleanup(false, async () => {
        const resources = getCliPluginInvocationResources()!;
        const registry = await resources.acquire(fixture.load);
        const resolveProviders = () =>
          resolvePluginProviders({
            config: fixture.config,
            env: fixture.env,
            onlyPluginIds: [fixture.id],
          });
        try {
          const captured = await resources.run(() =>
            withPluginRuntimeRegistryScope(registry, () =>
              withLocalGatewayRequestScope(
                { deps: {}, getRuntimeConfig: () => fixture.config },
                () => {
                  const scope = getPluginRuntimeGatewayRequestScope();
                  if (!scope) {
                    throw new Error("The local Gateway must retain its request scope");
                  }
                  return { scope, providers: resolveProviders() };
                },
              ),
            ),
          );
          expect(captured.providers).toHaveLength(1);
          expect(
            captured.providers[0]?.isCacheTtlEligible?.({
              provider: fixture.id,
              modelId: "synthetic-model",
            }),
          ).toBe(true);
          await resources.release();
          expect(fixture.state.disposals).toBe(1);
          expect(fixture.state.database?.isOpen).toBe(false);
          expect(() =>
            foreign.run(() =>
              withPluginRuntimeGatewayRequestScope(captured.scope, resolveProviders),
            ),
          ).toThrow("SDK resource host is closed");
        } finally {
          await resources.release();
        }
      }),
    );
  } finally {
    await foreign.close();
    await state.cleanup();
  }
});

it.each(["returned", "cooperating"] as const)(
  "keeps native SDK provider resources through %s cleanup work after the five-second grace",
  async (mode) => {
    const fixture = nativeFixture({ sdkProvider: true });
    await withCliProcessScope(() =>
      withCliCommandCleanup(false, async (cleanup) => {
        const resources = getCliPluginInvocationResources()!;
        const registry = await resources.acquire(fixture.load);
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        let descendant: Promise<void> | undefined;
        const actualCleanup = async () => {
          entered.resolve();
          await resume.promise;
          const providers = withPluginRuntimeRegistryScope(registry, () =>
            resolvePluginProviders({
              config: fixture.config,
              env: fixture.env,
              onlyPluginIds: [fixture.id],
            }),
          );
          expect(providers).toHaveLength(1);
          expect(
            providers[0]!.isCacheTtlEligible?.({
              provider: fixture.id,
              modelId: "synthetic-model",
            }),
          ).toBe(true);
          fixture.state.afterCleanup = fixture.state.database!.prepare("SELECT 42 AS value").get();
        };
        const dispose = async () => {
          descendant = trackAsyncWork(actualCleanup);
          if (mode === "returned") {
            await descendant;
          }
        };
        const harness: AgentHarness = {
          id: "native-cleanup",
          label: "Native cleanup",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("cleanup-only fixture");
          },
          dispose,
        };
        withPluginRegistrationContext(registry, fixture.id, () => registerAgentHarness(harness));
        withPluginRuntimeRegistryScope(registry, () => getRegisteredAgentHarness(harness.id));
        vi.useFakeTimers();
        const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        const closing = closeCliResources(cleanup);
        let release: Promise<void> | undefined;
        try {
          await entered.promise;
          await vi.advanceTimersByTimeAsync(5_000);
          await closing;
          if (mode === "returned") {
            expect(getPendingCliDisposers()).toContain("agent-harness/native-cleanup");
            expect(stderr).toHaveBeenCalledWith(expect.stringContaining("native-cleanup"));
          } else {
            // A completed disposer wrapper is not evidence that its admitted descendant finished.
            expect(getPendingCliDisposers()).not.toContain("agent-harness/native-cleanup");
          }
          release = resources.release();
          await vi.advanceTimersByTimeAsync(0);
          expect(fixture.state.database!.isOpen).toBe(true);
          expect(fixture.state.disposals).toBe(0);
        } finally {
          resume.resolve();
          await Promise.allSettled([closing, descendant]);
          await (release ?? resources.release());
        }
        await expect(descendant).resolves.toBeUndefined();
        expect(fixture.state.afterCleanup).toEqual({ value: 42 });
        expect(fixture.state.disposals).toBe(1);
        expect(getPendingCliDisposers()).not.toContain("agent-harness/native-cleanup");
      }),
    );
  },
);

it("releases the first native acquisition even when it is created only during cleanup", async () => {
  const fixture = nativeFixture();
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      // The invocation captures its owner before any registry or command preparation exists.
      const resources = cleanup?.pluginResources;
      const dispose = async () => {
        await getCliPluginInvocationResources()!.acquire(fixture.load);
        fixture.state.afterCleanup = fixture.state.database!.prepare("SELECT 42 AS value").get();
      };
      const harness: AgentHarness = {
        id: "late-native-cleanup",
        label: "Late native cleanup",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("cleanup-only fixture");
        },
        dispose,
      };
      cleanup!.harnesses.set(harness, dispose);
      try {
        await closeCliResources(cleanup);
      } finally {
        await resources?.release();
      }
      expect(fixture.state.afterCleanup).toEqual({ value: 42 });
      expect(fixture.state.disposals).toBe(1);
      expect(fixture.state.database!.isOpen).toBe(false);
    }),
  );
});

it("attempts independent resource releases and retains cleanup failures", async () => {
  const failed = nativeFixture({ disposalFailure: true });
  const sibling = nativeFixture();
  const resources = new CliPluginInvocationResources();
  await resources.acquire(failed.load);
  await resources.acquire(sibling.load);
  let reentered: Promise<void> | undefined;
  await resources.run(() =>
    getAsyncWorkSignal()!.addEventListener("abort", () => {
      reentered = resources.release();
    }),
  );
  const release = resources.release();
  expect(resources.release()).toBe(release);
  await expect(release).rejects.toThrow("could not all be disposed");
  expect(reentered).toBe(release);
  await expect(resources.release()).rejects.toThrow("could not all be disposed");
  expect([failed.state.disposals, sibling.state.disposals]).toEqual([1, 1]);
});

it("leaves standalone command programs with their caller after registration returns", async () => {
  const fixture = nativeFixture();
  fixture.state.resume.resolve();
  const program = new Command();
  await registerPluginCliCommands(program, fixture.config, fixture.env);
  expect(getCliPluginInvocationResources()).toBeUndefined();
  expect(program.commands.map((command) => command.name())).toEqual(["native"]);
  await program.parseAsync(["node", "fixture", "native"]);
  expect(fixture.state.afterCleanup).toEqual({ value: 42 });
  expect(fixture.state.disposals).toBe(0);
  expect(fixture.state.database!.isOpen).toBe(true);
});

it.each(["async-context", "work-tracker"] as const)(
  "keeps the registration's captured %s usable through native disposal",
  async (capturedDisposal) => {
    const fixture = nativeFixture({ capturedDisposal });
    const resources = new CliPluginInvocationResources();
    await resources.acquire(fixture.load);
    let failure: unknown;
    try {
      await resources.release();
    } catch (error) {
      failure = error;
    }
    expect(
      {
        nativeRead: fixture.state.disposalRead,
        disposals: fixture.state.disposals,
        open: fixture.state.database!.isOpen,
      },
      JSON.stringify(failure, ["message", "errors", "cause"]),
    ).toEqual({
      nativeRead: { value: 42 },
      disposals: 1,
      open: false,
    });
    expect(failure).toBeUndefined();
  },
);

it("joins queued abort cleanup before starting native resource disposal", async () => {
  const fixture = nativeFixture({ queuedAbortCleanup: true });
  const resources = new CliPluginInvocationResources();
  await resources.acquire(fixture.load);
  await resources.release();
  await expect(fixture.state.abortCleanup).resolves.toBeUndefined();
  expect(fixture.state.abortRead).toEqual({ value: 42 });
  expect(fixture.state.disposals).toBe(1);
  expect(fixture.state.database!.isOpen).toBe(false);
});

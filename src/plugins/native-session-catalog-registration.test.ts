import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../packages/gateway-protocol/src/index.js";
import { createConfigIO } from "../config/io.factory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import { SessionCatalogListLifetime } from "../gateway/server-methods/session-catalog-list-lifetime.js";
import { listSessionCatalogProvider } from "../gateway/server-methods/session-catalog-provider-access.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { PluginInstanceDrainTimeoutError } from "./plugin-instance-error.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createPluginRegistry } from "./registry.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { validatePluginSchemaValue } from "./schema-validator.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const roots: string[] = [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function registerCatalog(
  configExists: boolean | "dangling" | "fresh",
  initial?: boolean,
  options: {
    pluginId?: string;
    legacyDefaultEnabled?: boolean;
    createListOperation?: SessionCatalogProvider["createListOperation"];
  } = {},
) {
  const pluginId = options.pluginId ?? "fixture";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-catalog-"));
  roots.push(root);
  const configPath = path.join(root, "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  let source: OpenClawConfig =
    initial === undefined
      ? {}
      : {
          plugins: {
            entries: { [pluginId]: { config: { sessionCatalog: { enabled: initial } } } },
          },
        };
  if (configExists === "dangling") {
    await fs.symlink(path.join(root, "missing.json"), configPath);
  } else if (configExists === true) {
    await fs.writeFile(configPath, JSON.stringify(source));
  }
  const env = { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
  const io = createConfigIO({
    env,
    homedir: () => root,
    observe: false,
    pluginValidation: "core-only",
  });
  if (configExists === "fresh") {
    await io.writeConfigFile(source);
  }
  const snapshot = await io.readConfigFileSnapshot();
  expect(snapshot.exists).toBe(configExists === true || configExists === "fresh");
  const manifest: PluginManifestRecord = {
    id: pluginId,
    channels: [],
    providers: [],
    cliBackends: [],
    hooks: [],
    skills: [],
    origin: "bundled",
    enabledByDefault: true,
    rootDir: root,
    source: path.join(root, "index.js"),
    manifestPath: path.join(root, "openclaw.plugin.json"),
    setup: {
      nativeSessionCatalog: {
        label: "Fixture",
        nodeCommands: ["fixture.sessions.list", "fixture.sessions.static"],
        ...(options.legacyDefaultEnabled !== undefined
          ? { legacyDefaultEnabled: options.legacyDefaultEnabled }
          : {}),
      },
    },
    configSchema: {
      type: "object",
      properties: {
        sessionCatalog: {
          type: "object",
          default: {},
          properties: {
            enabled: { type: "boolean", default: true },
            pageSize: { type: "integer", default: 10 },
          },
        },
      },
    },
  };
  const pluginLocal = validatePluginSchemaValue({
    origin: "bundled",
    schema: manifest.configSchema!,
    cacheKey: manifest.manifestPath,
    value: {},
    applyDefaults: true,
  });
  expect(pluginLocal).toMatchObject({
    ok: true,
    value: { sessionCatalog: { enabled: true, pageSize: 10 } },
  });
  const validate = (input: OpenClawConfig) => {
    const validated = validateConfigObjectWithPlugins(
      {
        ...input,
        plugins: { ...input.plugins, slots: { memory: "none" } },
      },
      {
        env,
        homedir: () => root,
        pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [manifest] } },
      },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      throw new Error("Fixture configuration is invalid");
    }
    return validated.config;
  };
  let config = validate(snapshot.sourceConfig ?? source);
  expect(config.plugins?.entries?.[pluginId]?.config).toEqual({
    sessionCatalog: {
      ...(initial !== undefined ? { enabled: initial } : {}),
      pageSize: 10,
    },
  });
  const registry = createPluginRegistry({
    runtime: { config: { current: () => config } } as PluginRuntime,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: pluginId,
    source: manifest.source,
    nativeSessionCatalog: manifest.setup?.nativeSessionCatalog,
  });
  registry.registry.plugins.push(record);
  const api = registry.createApi(record, { config });
  const dispose = async () => {
    await getPluginInstance(record)?.dispose();
  };
  disposals.push(dispose);
  const list = vi.fn(async () => []);
  const read = vi.fn(async () => ({ hostId: "local", threadId: "thread", items: [] }));
  const available = vi.fn(() => true);
  const handle = vi.fn(async () => "[]");
  const staticHandle = vi.fn(async () => "[]");
  api.registerSessionCatalog({
    id: "fixture",
    label: "Fixture",
    list,
    read,
    ...(options.createListOperation ? { createListOperation: options.createListOperation } : {}),
  });
  api.registerNodeHostCommand({ command: "fixture.sessions.list", isAvailable: available, handle });
  // Static definitions use the registrar directly even in setup-only modes.
  registry.registerNodeHostCommand(record, {
    command: "fixture.sessions.static",
    handle: staticHandle,
  });
  return {
    dispose,
    instance: getPluginInstance(record)!,
    registry: registry.registry,
    provider: registry.registry.sessionCatalogs[0]!.provider,
    node: registry.registry.nodeHostCommands[0]!.command,
    staticNode: registry.registry.nodeHostCommands[1]!.command,
    list,
    read,
    available,
    handle,
    staticHandle,
    async setPreference(enabled: boolean) {
      source = {
        plugins: { entries: { [pluginId]: { config: { sessionCatalog: { enabled } } } } },
      };
      await fs.writeFile(configPath, JSON.stringify(source));
      const updated = await io.readConfigFileSnapshot();
      config = validate(updated.sourceConfig);
    },
  };
}

describe("registered native catalog access", () => {
  it.each(["close", "release registration"] as const)(
    "retains issued completion through a %s failure",
    async (failure) => {
      const completion = createDeferredCore();
      const error = new Error("cleanup boundary failed");
      const cleanup = vi.fn();
      const close = vi.fn(() => {
        if (failure === "close") {
          throw error;
        }
      });
      const state = await registerCatalog(true, true, {
        createListOperation: (params) => ({
          next: async () => {
            params.waitUntil?.(completion.promise);
            return { done: true, hosts: [] };
          },
          close,
        }),
      });
      state.instance.lifecycle.onDispose(cleanup);
      let registrations = 0;
      let settled = false;
      const pending = withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: state.registry, pluginId: "fixture", isWebchatConnect: () => false },
        () =>
          listSessionCatalogProvider(state.provider, {
            waitUntil: () => {
              if (++registrations === 2 && failure === "release registration") {
                throw error;
              }
            },
          }),
      );
      const outcome = pending
        .catch((reason: unknown) => reason)
        .finally(() => {
          settled = true;
        });
      try {
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        const disposal = state.dispose();
        expect(cleanup).not.toHaveBeenCalled();
        expect(state.instance.hasRetainedConsumers).toBe(true);
        if (failure === "close") {
          expect(await outcome).toBe(error);
        } else {
          expect(settled).toBe(false);
        }
        completion.resolve();
        expect(await outcome).toBe(error);
        await disposal;
        expect(registrations).toBe(2);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(state.instance.hasRetainedConsumers).toBe(false);
      } finally {
        completion.resolve();
        await outcome;
      }
    },
  );

  it("owns cleanup before a factory can retire its own instance", async () => {
    let retire = () => {};
    const next = vi.fn(async () => ({ done: true as const, hosts: [] }));
    const close = vi.fn();
    const cleanup = vi.fn();
    const state = await registerCatalog(true, true, {
      createListOperation: () => {
        retire();
        return { next, close };
      },
    });
    retire = () => {
      void state.dispose();
    };
    state.instance.lifecycle.onDispose(cleanup);
    await expect(
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: state.registry, pluginId: "fixture", isWebchatConnect: () => false },
        () => listSessionCatalogProvider(state.provider, {}),
      ),
    ).rejects.toThrow("reloaded or disabled");
    await state.dispose();
    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(state.instance.hasRetainedConsumers).toBe(false);
  });

  it.each(["queued", "completed"] as const)(
    "retains the registered instance through a %s operation and its publication tail",
    { timeout: 15_000 },
    async (phase) => {
      const blockers = createDeferredCore<SessionCatalogHost[]>();
      const first = createDeferredCore<{ done: false }>();
      const publication = createDeferredCore();
      const close = vi.fn();
      const next = vi.fn();
      const cleanup = vi.fn();
      let guardedPublication: () => void = () => {};
      const state = await registerCatalog(true, true, {
        createListOperation: (params) => {
          return {
            async next() {
              next();
              params.waitUntil?.(publication.promise.then(() => guardedPublication()));
              return phase === "queued" ? await first.promise : { done: true, hosts: [] };
            },
            close,
          };
        },
      });
      state.instance.lifecycle.onDispose(cleanup);
      const published = vi.fn(() => {
        if (phase === "queued") {
          throw new Error("publication rejected");
        }
      });
      guardedPublication = state.instance.wrap(published);
      const owner = new AbortController();
      const lifetime = new SessionCatalogListLifetime(
        () => true,
        [owner.signal],
        [state.provider.id],
      );
      const blocker: SessionCatalogProvider = {
        id: "blocking",
        label: "Blocking",
        list: () => blockers.promise,
        read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
      };
      const active = Array.from({ length: phase === "queued" ? 3 : 0 }, (_, index) =>
        listSessionCatalogProvider({ ...blocker, id: `blocking-${index}` }, {}),
      );
      const pending = withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: state.registry, pluginId: "fixture", isWebchatConnect: () => false },
        () =>
          lifetime.runProvider(undefined, (params) =>
            listSessionCatalogProvider(state.provider, params),
          ),
      );
      const outcome = pending.catch((error: unknown) => error);
      const successorStarted = createDeferredCore();
      const successor =
        phase === "queued"
          ? listSessionCatalogProvider(
              {
                ...blocker,
                id: "successor",
                list: () => {
                  successorStarted.resolve();
                  return blockers.promise;
                },
              },
              {},
            )
          : Promise.resolve([]);
      try {
        if (phase === "queued") {
          first.resolve({ done: false });
          await successorStarted.promise;
        } else {
          await expect(pending).resolves.toEqual([]);
          expect(close).toHaveBeenCalledOnce();
        }
        vi.useFakeTimers();
        const disposal = state.instance.dispose();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(cleanup).not.toHaveBeenCalled();
        expect(state.instance.lifecycle.signal.aborted).toBe(false);
        expect(state.instance.hasRetainedConsumers).toBe(true);
        await vi.advanceTimersByTimeAsync(51);
        const timeout = (await disposal).errors[0];
        expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
        if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
          throw new Error("Expected bounded logical retirement");
        }
        expect(timeout.forcedRetirement).toEqual({ activeCallCount: 0, retainedConsumerCount: 1 });
        expect(state.instance.lifecycle.signal.aborted).toBe(true);
        expect(state.instance.hasRetainedConsumers).toBe(true);
        expect(cleanup).not.toHaveBeenCalled();
        if (phase === "queued") {
          const retirement = new Error("catalog owner retired");
          owner.abort(retirement);
          expect(await outcome).toBe(retirement);
          expect(close).toHaveBeenCalledOnce();
        }
        expect(next).toHaveBeenCalledOnce();
        expect(published).not.toHaveBeenCalled();
        publication.resolve();
        await timeout.settled;
        expect(published).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(state.instance.hasRetainedConsumers).toBe(false);
        expect(state.instance.lifecycle.signal.aborted).toBe(true);
      } finally {
        owner.abort(new Error("test cleanup"));
        first.resolve({ done: false });
        blockers.resolve([]);
        publication.resolve();
        await Promise.allSettled([...active, pending, successor]);
        lifetime.finishListing();
      }
    },
  );

  it("keeps initially disabled list operations empty without constructing a source", async () => {
    const next = vi.fn(async () => ({ done: true as const, hosts: [] }));
    const close = vi.fn();
    const createListOperation = vi.fn<NonNullable<SessionCatalogProvider["createListOperation"]>>(
      function (this: SessionCatalogProvider, query) {
        expect(this.id).toBe("fixture");
        expect(query.agentId).toBe("research");
        return { next, close };
      },
    );
    const state = await registerCatalog(true, false, { createListOperation });
    const operation = state.provider.createListOperation!({ agentId: "research" });
    expect(createListOperation).not.toHaveBeenCalled();
    await expect(operation.next()).resolves.toEqual({ done: true, hosts: [] });
    await state.setPreference(true);
    await expect(operation.next()).resolves.toEqual({ done: true, hosts: [] });
    expect(createListOperation).not.toHaveBeenCalled();
    operation.close();
    await expect(operation.next()).rejects.toThrow("operation is closed");

    const enabled = state.provider.createListOperation!({ agentId: "research" });
    await expect(enabled.next()).resolves.toEqual({ done: true, hosts: [] });
    enabled.close();
    enabled.close();
    expect(createListOperation).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(state.list).not.toHaveBeenCalled();
  });

  it.each(["between steps", "during a step"] as const)(
    "rejects consent revoked %s without publishing a partial success",
    async (when) => {
      const held = createDeferredCore<{ done: false }>();
      const next = vi.fn(() => held.promise);
      const close = vi.fn();
      const state = await registerCatalog(true, true, {
        createListOperation: () => ({ next, close }),
      });
      const operation = state.provider.createListOperation!({});
      const first = operation.next();
      try {
        if (when === "between steps") {
          held.resolve({ done: false });
          await expect(first).resolves.toEqual({ done: false });
          await state.setPreference(false);
          await expect(operation.next()).rejects.toThrow("discovery is disabled");
        } else {
          const rejected = expect(first).rejects.toThrow("discovery is disabled");
          await state.setPreference(false);
          expect(close).not.toHaveBeenCalled();
          held.resolve({ done: false });
          await rejected;
        }
        expect(next).toHaveBeenCalledOnce();
        operation.close();
        expect(close).toHaveBeenCalledOnce();
      } finally {
        held.resolve({ done: false });
        await first.catch(() => {});
        operation.close();
      }
    },
  );

  it.each([false, true])(
    "rejects retained catalog and node calls after instance retirement (enabled: %s)",
    async (enabled) => {
      const state = await registerCatalog(true, enabled);
      await state.provider.list({});
      expect(state.list).toHaveBeenCalledTimes(enabled ? 1 : 0);
      await state.dispose();
      await expect(Promise.resolve().then(() => state.provider.list({}))).rejects.toThrow(
        /reloaded|disabled/,
      );
      expect(() => state.node.isAvailable?.({ config: {}, env: {} })).toThrow(/reloaded|disabled/);
      await expect(Promise.resolve().then(() => state.staticNode.handle())).rejects.toThrow(
        /reloaded|disabled/,
      );
      expect(state.list).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(state.available).not.toHaveBeenCalled();
      expect(state.staticHandle).not.toHaveBeenCalled();
    },
  );

  it("requires opt-in for a new declared catalog after fresh configuration is written", async () => {
    const state = await registerCatalog("fresh", undefined, { legacyDefaultEnabled: true });
    await state.provider.list({});
    expect(state.list).not.toHaveBeenCalled();
    await expect(state.node.handle()).rejects.toThrow("discovery is disabled");
    await expect(state.staticNode.handle()).rejects.toThrow("discovery is disabled");
    await state.setPreference(true);
    await state.provider.list({});
    expect(state.list).toHaveBeenCalledOnce();
  });
  it("does not inherit a legacy opt-in from a dangling config link", async () => {
    const state = await registerCatalog("dangling");
    expect(await state.provider.list({})).toEqual([]);
    await expect(state.node.handle()).rejects.toThrow("discovery is disabled");
    await expect(state.staticNode.handle()).rejects.toThrow("discovery is disabled");
    expect(state.list).not.toHaveBeenCalled();
    expect(state.handle).not.toHaveBeenCalled();
    expect(state.staticHandle).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "blocks validated defaults from granting consent (file exists: %s)",
    async (exists) => {
      const state = await registerCatalog(exists, exists ? false : undefined);
      expect(await state.provider.list({ agentId: "research" })).toEqual([]);
      await expect(state.provider.read({ hostId: "local", threadId: "thread" })).rejects.toThrow(
        "discovery is disabled",
      );
      expect(state.node.isAvailable?.({ config: {}, env: {} })).toBe(false);
      await expect(state.node.handle()).rejects.toThrow("discovery is disabled");
      await expect(state.staticNode.handle()).rejects.toThrow("discovery is disabled");
      expect(state.list).not.toHaveBeenCalled();
      expect(state.read).not.toHaveBeenCalled();
      expect(state.available).not.toHaveBeenCalled();
      expect(state.handle).not.toHaveBeenCalled();
      expect(state.staticHandle).not.toHaveBeenCalled();
      await state.setPreference(true);
      await state.provider.list({});
      await state.provider.read({ hostId: "local", threadId: "thread" });
      expect(state.node.isAvailable?.({ config: {}, env: {} })).toBe(true);
      await state.node.handle();
      await state.staticNode.handle();
      expect(state.list).toHaveBeenCalledOnce();
      expect(state.read).toHaveBeenCalledOnce();
      expect(state.handle).toHaveBeenCalledOnce();
      expect(state.staticHandle).toHaveBeenCalledOnce();
    },
  );

  it("preserves omitted legacy defaults and rechecks explicit disabling on retained handles", async () => {
    const state = await registerCatalog(true, undefined, { pluginId: "codex" });
    await state.provider.list({});
    await state.node.handle();
    await state.setPreference(false);
    expect(await state.provider.list({})).toEqual([]);
    await expect(state.node.handle()).rejects.toThrow("discovery is disabled");
    expect(state.list).toHaveBeenCalledOnce();
    expect(state.handle).toHaveBeenCalledOnce();
  });
});

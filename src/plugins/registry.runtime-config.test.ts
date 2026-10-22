import { AsyncResource } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listRegisteredAgentHarnesses,
  registerAgentHarness,
  resolveAgentHarnessQueueInputAdapter,
} from "../agents/harness/registry.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { withCliCommandCleanup, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { resolveUserPath } from "../utils.js";
import {
  createLazyPluginRuntime,
  runPluginRegisterSyncInRegistry,
} from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "./registry-lifecycle.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createEmptyPluginRegistry, createPluginRegistry } from "./registry.js";
import { disposePluginRegistryInstances, withPluginRegistrationContext } from "./runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import * as sdkAlias from "./sdk-alias.js";

afterEach(() => vi.restoreAllMocks());

function createHarness(id: string) {
  return {
    id,
    label: id,
    supports: () => ({ supported: true as const }),
    runAttempt: async () => {
      throw new Error("unused");
    },
  };
}

function scopeCapture() {
  const scopes: ReturnType<typeof getPluginRuntimeGatewayRequestScope>[] = [];
  return {
    capture<T>(result: () => T) {
      return () => {
        scopes.push(getPluginRuntimeGatewayRequestScope());
        return result();
      };
    },
    expectOwner(id: string, count: number) {
      expect(scopes).toHaveLength(count);
      for (const scope of scopes) {
        expect(scope).toMatchObject({ pluginId: id, pluginSource: `/plugins/${id}/index.js` });
      }
    },
    scopes,
  };
}

function createRecord(
  id: string,
  overrides: Partial<Parameters<typeof createPluginRecord>[0]> = {},
) {
  return createPluginRecord({
    id,
    source: `/plugins/${id}/index.js`,
    origin: "global",
    enabled: true,
    configSchema: false,
    ...overrides,
  });
}

type CreateSession = PluginRuntime["agent"]["session"]["createSessionEntry"];
type CreateParams = Parameters<CreateSession>[0];

function registered(
  id: string,
  overrides: Parameters<typeof createRecord>[1] = {},
  runtime = createPluginRuntime(),
) {
  const builder = createRuntimeTestRegistry(runtime);
  const record = createRecord(id, overrides);
  return { builder, record, api: builder.createApi(record, { config: {} }) };
}

function sessionFixture(id: string) {
  const runtime = createPluginRuntime();
  const createSessionEntry = vi.fn<CreateSession>(async (params) => ({
    key: params.key,
    agentId: "main",
    sessionId: "session-1",
    entry: { sessionId: "session-1", updatedAt: 1 },
  }));
  runtime.agent.session.createSessionEntry = createSessionEntry;
  return { ...registered(id, { origin: "bundled" }, runtime), createSessionEntry };
}

function expectRejectedHarness(
  { builder, record }: ReturnType<typeof registered>,
  message: string,
) {
  expect(builder.registry.agentHarnesses).toEqual([]);
  expect(record.agentHarnessIds).toEqual([]);
  expect(builder.registry.diagnostics).toContainEqual(
    expect.objectContaining({ level: "error", pluginId: record.id, message }),
  );
}

async function expectSessionNamespace(
  { api, createSessionEntry, record }: ReturnType<typeof sessionFixture>,
  key: string,
  initialEntry: CreateParams["initialEntry"],
  conflict: CreateParams,
) {
  const create = api.runtime.agent.session.createSessionEntry;
  await expect(create({ cfg: {}, key, initialEntry })).resolves.toEqual(
    expect.objectContaining({ sessionId: "session-1" }),
  );
  expect(createSessionEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      initialEntry: expect.objectContaining({ pluginOwnerId: record.id }),
    }),
  );
  await expect(create({ cfg: {}, key: "agent:main:ordinary", initialEntry })).rejects.toThrow(
    `must start with "plugin:${record.id}:"`,
  );
  await expect(create(conflict)).rejects.toThrow("requires exactly one runtime owner");
}

describe("plugin registration runtime admission", () => {
  function fixture(origin: "config" | "bundled" = "config") {
    const list = vi.fn(async () => ({ nodes: [] }));
    const runtime = createPluginRuntime();
    runtime.nodes.list = list;
    const builder = createPluginRegistry({
      runtime,
      activateGlobalSideEffects: false,
      logger: { info() {}, warn() {}, error() {} },
    });
    const record = createRecord("register-runtime", { origin });
    const api = builder.createApi(record, { config: {} });
    const owner = expectDefined(getPluginInstance(record), "registration instance");
    return { builder, record, api, owner, list };
  }

  it("rejects a retained ingress purge after runtime retirement without changing rows", async () => {
    await withStateDirEnv("plugin-ingress-retirement-", async ({ stateDir }) => {
      const { builder, record, api, owner } = fixture("bundled");
      builder.registry.plugins.push(record);
      const queue = api.runtime.state.openChannelIngressQueue<{ text: string }>({
        accountId: "default",
        stateDir,
      });
      try {
        await queue.enqueue("active", { text: "active owner" });
        expect(await queue.purge?.()).toBe(1);
        await queue.enqueue("pending", { text: "replacement work" });
        await queue.enqueue("claimed", { text: "in flight" });
        await queue.claim("claimed");
        const pending = await queue.listPending();
        const claims = await queue.listClaims();
        const purge = expectDefined(queue.purge?.bind(queue), "core purge");

        revokePluginRecord(builder.registry, record);

        await expect(purge()).rejects.toThrow("runtime is no longer active");
        const inspector = createChannelIngressQueue({
          channelId: record.id,
          accountId: "default",
          stateDir,
          access: "read-only",
        });
        expect(await inspector.listPending()).toEqual(pending);
        expect(await inspector.listClaims()).toEqual(claims);
      } finally {
        await owner.dispose();
        await closeOpenClawStateDatabaseAsync();
      }
    });
  });

  it("retains an inspected harness until terminal CLI cleanup without reopening ordinary calls", async () => {
    const { builder, record, api, owner } = fixture();
    const dispose = vi.fn(async () => {});
    const physicalCleanup = vi.fn();
    owner.lifecycle.onDispose(physicalCleanup);
    api.registerAgentHarness({
      ...createHarness("owned"),
      label: "Owned",
      dispose,
    });
    builder.registry.plugins.push(record);
    const inspection = new PluginRegistryInspectionResources(async () => {
      await owner.dispose();
    });
    inspection.attach(builder.registry);
    await withCliProcessScope(() =>
      withCliCommandCleanup(false, async (cleanup) => {
        const command = expectDefined(cleanup, "CLI cleanup owner");
        try {
          const [registration] = withPluginRuntimeRegistryScope(
            builder.registry,
            listRegisteredAgentHarnesses,
          );
          await inspection.release();
          expect(physicalCleanup).not.toHaveBeenCalled();
          expect(() => registration!.harness.dispose?.()).toThrow(/reloaded|disabled/);
          for (const finish of command.harnesses.values()) {
            await finish();
          }
          expect(dispose).toHaveBeenCalledOnce();
        } finally {
          await inspection.release();
          await command.pluginResources?.release();
        }
      }),
    );
    expect(physicalCleanup).toHaveBeenCalledOnce();
  });

  it("does not close a shared harness client when an in-process peer retires", async () => {
    const first = fixture();
    const second = fixture();
    let closed = false;
    const harness = {
      ...createHarness("shared"),
      label: "Shared",
      loadModelCatalog: async () => {
        if (closed) {
          throw new Error("shared client is closed");
        }
        return { entries: [] };
      },
      dispose: async () => {
        closed = true;
      },
    };
    first.api.registerAgentHarness(harness);
    second.api.registerAgentHarness(harness);
    try {
      await first.owner.dispose();
      const peer = expectDefined(second.builder.registry.agentHarnesses[0], "live peer");
      await expect(
        peer.harness.loadModelCatalog?.({
          config: {},
          agentId: "main",
          agentDir: "/fixture/agent",
          workspaceDir: "/fixture/workspace",
        }),
      ).resolves.toEqual({ entries: [] });
      expect(closed).toBe(false);
    } finally {
      await second.owner.dispose();
    }
  });

  it("allows the canonical synchronous registration call before publication", async () => {
    const { builder, record, api, owner, list } = fixture();
    let pending: ReturnType<PluginRuntime["nodes"]["list"]> | undefined;
    try {
      runPluginRegisterSyncInRegistry(
        (registeredApi) => {
          pending = registeredApi.runtime.nodes.list({ connected: true });
        },
        api,
        builder.registry,
        record.id,
      );
      await expect(pending).resolves.toEqual({ nodes: [] });
      expect(list).toHaveBeenCalledExactlyOnceWith({ connected: true });
      expect(builder.registry.plugins).toEqual([]);
    } finally {
      await owner.dispose();
    }
  });

  it("rejects admitted registration metadata without its producer binding", async () => {
    const { builder, record, api, owner, list } = fixture();
    const invoke = () =>
      withPluginRegistrationContext(builder.registry, record.id, () =>
        api.runtime.nodes.list({ connected: true }),
      );
    try {
      expect(() => owner.run(invoke)).toThrow("runtime is no longer active");
      expect(list).not.toHaveBeenCalled();
    } finally {
      await owner.dispose();
    }
  });

  it("rejects a retained runtime helper after its admitted instance is removed", async () => {
    const { builder, record, api, owner, list } = fixture();
    builder.registry.plugins.push(record);
    const retained = api.runtime.nodes.list;
    const resume = createDeferredCore();
    const pending = owner.run(async () => {
      await resume.promise;
      return withPluginRegistrationContext(builder.registry, record.id, () =>
        retained({ connected: true }),
      );
    });
    const rejected = expect(pending).rejects.toThrow("runtime is no longer active");
    try {
      builder.rollbackPluginGlobalSideEffects(record.id, record);
      builder.registry.plugins.splice(0, 1);
      resume.resolve();
      await rejected;
      expect(list).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await Promise.allSettled([pending, owner.dispose()]);
    }
  });
});

describe("plugin registry runtime config scope", () => {
  it("keeps STT interception on its runtime source while resolving each call's registry", async () => {
    const runtime = createPluginRuntime();
    const source = runtime.mediaUnderstanding;
    source.transcribeAudioFile = async () => ({
      text: getPluginRuntimeGatewayRequestScope()?.pluginRegistry?.coreGatewayMethodNames[0],
    });
    const { builder, record, api } = registered("stable-media", {}, runtime);
    const instance = expectDefined(getPluginInstance(record), "media instance");
    builder.registry.coreGatewayMethodNames.push("original");
    markPluginRegistryActive(builder.registry);
    const facade = api.runtime.mediaUnderstanding;
    const transcribe = facade.transcribeAudioFile.bind(facade);
    const intercept = vi.spyOn(facade, "transcribeAudioFile").mockImplementation(async (params) => {
      const result = await transcribe(params);
      return { ...result, text: `intercepted:${result.text}` };
    });
    const request = { cfg: {}, filePath: "/synthetic/voice.wav" };
    const successor = { ...builder.registry, coreGatewayMethodNames: ["successor"] };
    try {
      await expect(
        api.runtime.mediaUnderstanding.transcribeAudioFile(request),
      ).resolves.toMatchObject({
        text: "intercepted:original",
      });
      markPluginRegistryActive(successor);
      markPluginRegistryRetired(builder.registry);
      await expect(
        api.runtime.mediaUnderstanding.transcribeAudioFile(request),
      ).resolves.toMatchObject({
        text: "intercepted:successor",
      });
      const selected = createEmptyPluginRegistry();
      selected.coreGatewayMethodNames.push("prepared");
      await expect(
        withPluginRuntimeRegistryScope(selected, () =>
          api.runtime.mediaUnderstanding.transcribeAudioFile(request),
        ),
      ).resolves.toMatchObject({ text: "intercepted:prepared" });
      expect(intercept).toHaveBeenCalledTimes(3);

      const replacement: PluginRuntime["mediaUnderstanding"] = {
        ...source,
        transcribeAudioFile: async () => ({
          text: `replacement:${getPluginRuntimeGatewayRequestScope()?.pluginRegistry?.coreGatewayMethodNames[0]}`,
        }),
      };
      Object.defineProperty(runtime, "mediaUnderstanding", {
        value: replacement,
        configurable: true,
      });
      await expect(
        api.runtime.mediaUnderstanding.transcribeAudioFile(request),
      ).resolves.toMatchObject({
        text: "replacement:successor",
      });
      expect(intercept).toHaveBeenCalledTimes(3);
      intercept.mockRestore();
      revokePluginRecord(successor, record);
      expect(() => facade.transcribeAudioFile(request)).toThrow("runtime is no longer active");
      expect(() => api.runtime.mediaUnderstanding.transcribeAudioFile(request)).toThrow(
        "runtime is no longer active",
      );
    } finally {
      intercept.mockRestore();
      await instance.dispose();
      markPluginRegistryRetired(successor);
    }
  });

  it("keeps adopted media capabilities alive without retaining retired registries", async () => {
    class RetiredRegistry {
      readonly fixtureLabel = "RetiredRegistry";
    }
    const runtime = createPluginRuntime();
    const { builder, record, api } = registered("hosted-media", {}, runtime);
    const instance = expectDefined(getPluginInstance(record), "media instance");
    builder.registry.plugins.push(record);
    const media = api.runtime.media;
    expect(media.detectMime).toBe(runtime.media.detectMime);
    const current = { ...builder.registry };
    const resource = (() => {
      const previous = Object.assign(new RetiredRegistry(), builder.registry);
      markPluginRegistryActive(previous);
      const captured = instance.run(() => new AsyncResource("hosted-media-retention"));
      markPluginRegistryActive(current);
      markPluginRegistryRetired(previous);
      return captured;
    })();
    const readFile = vi.fn(async (_filePath: string) => Buffer.from("synthetic media"));
    const load = () =>
      media.loadWebMedia("/synthetic/resolved.txt", {
        localRoots: "any",
        optimizeImages: false,
        readFile,
      });
    try {
      await setImmediate();
      expect(queryObjects(RetiredRegistry)).toBe(0);
      await expect(resource.runInAsyncScope(load)).resolves.toMatchObject({
        buffer: Buffer.from("synthetic media"),
        fileName: "resolved.txt",
      });
      expect(readFile.mock.calls[0]?.[0]).toBe("/synthetic/resolved.txt");
      await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), load);
      expect(readFile.mock.calls[1]?.[0]).toBe("/synthetic/resolved.txt");
    } finally {
      resource.emitDestroy();
      await instance.dispose();
      markPluginRegistryRetired(current);
    }
  });

  it.each(["plain", "custody"] as const)(
    "retains a pending %s runtime selection across adoption, then releases it",
    async (mode) => {
      class PendingRegistry {
        readonly fixtureLabel = "PendingRegistry";
      }
      const resume = createDeferredCore();
      const runtime = createPluginRuntime();
      runtime.llm.complete = async () => {
        await resume.promise;
        return {
          text:
            getPluginRuntimeGatewayRequestScope()?.pluginRegistry?.coreGatewayMethodNames[0] ??
            "missing",
          provider: "fixture",
          model: "fixture",
          agentId: "main",
          usage: {},
          execution: { mode: "direct-provider", owner: { kind: "provider", id: "fixture" } },
          audit: { caller: { kind: "plugin", id: "pending-runtime" } },
        };
      };
      const { builder, record, api } = registered("pending-runtime", {}, runtime);
      const instance = expectDefined(getPluginInstance(record), "runtime instance");
      markPluginRegistryActive(builder.registry);
      // Channel monitors retain instance custody without pinning a registry generation.
      const consumer =
        mode === "custody" ? instance.retainConsumer(undefined, undefined, "custody") : undefined;
      const successor = createEmptyPluginRegistry();
      successor.plugins.push(record);
      const pending = (() => {
        const selected = Object.assign(new PendingRegistry(), createEmptyPluginRegistry());
        selected.plugins.push(record);
        selected.coreGatewayMethodNames.push("intermediate");
        markPluginRegistryActive(selected);
        markPluginRegistryRetired(builder.registry);
        const invoke = () =>
          api.runtime.llm.complete({ messages: [{ role: "user", content: "fixture" }] });
        const operation = consumer ? consumer.run(invoke) : invoke();
        markPluginRegistryActive(successor);
        markPluginRegistryRetired(selected);
        return operation;
      })();
      try {
        await setImmediate();
        expect(queryObjects(PendingRegistry)).toBe(1);
        resume.resolve();
        await expect(pending).resolves.toMatchObject({ text: "intermediate" });
        await setImmediate();
        expect(queryObjects(PendingRegistry)).toBe(0);
        // Retaining the completed caller-visible Promise must not retain its old selection.
        await expect(pending).resolves.toMatchObject({ text: "intermediate" });
      } finally {
        resume.resolve();
        await Promise.allSettled([pending]);
        consumer?.release();
        await instance.dispose();
        markPluginRegistryRetired(successor);
      }
    },
  );

  it("rejects a plugin harness that claims the built-in runtime id", () => {
    const fixture = registered("untrusted-plugin");
    const { api } = fixture;

    api.registerAgentHarness(createHarness("openclaw"));

    expectRejectedHarness(
      fixture,
      'agent harness id "openclaw" is reserved for the built-in runtime',
    );
  });

  it.each([
    {
      label: "official global",
      source: "/plugins/node_modules/@openclaw/codex/index.js",
      origin: "global",
      packageName: "@openclaw/codex",
    },
  ] as const)("binds native compaction to the $label Codex harness", async (fixture) => {
    const { builder, record, api } = registered("codex", fixture);
    const nativeCompaction = vi.fn(async () => ({ ok: true, compacted: true }));
    const options = { nativeCompaction };

    api.registerAgentHarness(createHarness("codex"), options);

    expect(builder.registry.agentHarnesses).toHaveLength(1);
    const registration = expectDefined(builder.registry.agentHarnesses[0], "registered harness");
    const compact = expectDefined(registration.nativeCompaction, "native compaction callback");
    const request = {
      sessionId: "native-compaction-session",
      sessionFile: "/tmp/native-compaction/session",
      workspaceDir: "/tmp/native-compaction",
      nativeCompactionRequest: "required_preflight",
    } satisfies Parameters<typeof compact>[0];
    await expect(compact(request)).resolves.toEqual({ ok: true, compacted: true });
    expect(nativeCompaction).toHaveBeenCalledWith(request);
    expect(nativeCompaction.mock.contexts[0]).toBe(options);
    expect(registration.harness).not.toHaveProperty("compactNative");
    await expectDefined(getPluginInstance(record), "compaction owner").dispose();
    expect(() => compact(request)).toThrow(/reloaded|disabled|retiring/);
    expect(nativeCompaction).toHaveBeenCalledTimes(1);
  });

  it.each(["config", "global"] as const)(
    "rejects native compaction from a %s Codex impostor",
    (origin) => {
      const fixture = registered("codex", { source: "/plugins/impostor/index.js", origin });
      const { api } = fixture;

      api.registerAgentHarness(createHarness("codex"), {
        nativeCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
      });

      expectRejectedHarness(
        fixture,
        'native compaction requires the registry-owned "codex" harness',
      );
    },
  );

  it("resolves plugin API paths against the plugin root", () => {
    const pluginRoot = path.join(os.tmpdir(), "openclaw-plugins", "demo");
    const { api } = registered("path-plugin", {
      name: "Path Plugin",
      source: path.join(pluginRoot, "index.js"),
      rootDir: pluginRoot,
    });
    const absolute = path.resolve(pluginRoot, "..", "outside.txt");

    expect(api.resolvePath("data/cache.json")).toBe(path.join(pluginRoot, "data", "cache.json"));
    expect(api.resolvePath("./data/cache.json")).toBe(path.join(pluginRoot, "data", "cache.json"));
    expect(api.resolvePath(absolute)).toBe(absolute);
    expect(api.resolvePath("~/openclaw/plugin.txt")).toBe(resolveUserPath("~/openclaw/plugin.txt"));
  });

  it("adds plugin context to lazy runtime resolution failures", () => {
    const runtime = new Proxy({} as PluginRuntime, {
      get() {
        throw new Error("Unable to resolve plugin runtime module; loader=/tmp/openclaw-loader.js");
      },
    });
    const { api } = registered("diagnostic-plugin", { name: "Diagnostic Plugin" }, runtime);

    let thrown: unknown;
    try {
      void api.runtime.version;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected runtime resolution failure");
    }
    for (const text of [
      "Unable to resolve plugin runtime module",
      "pluginRuntimeContext=pluginId:diagnostic-plugin",
      "property:version",
      "source:/plugins/diagnostic-plugin/index.js",
    ]) {
      expect(thrown.message).toContain(text);
    }
  });

  it("runs config helpers with the owning plugin scope", async () => {
    const scope = scopeCapture();
    const config = {} as OpenClawConfig;
    const replaceResult = {
      path: "/tmp/openclaw.json",
      previousHash: null,
      persistedHash: "persisted-hash",
      snapshot: { path: "/tmp/openclaw.json" },
      nextConfig: config,
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    } as unknown as Awaited<ReturnType<PluginRuntime["config"]["replaceConfigFile"]>>;
    const configRuntime = {
      current: vi.fn(scope.capture(() => config)),
      mutateConfigFile: scope.capture(async () => ({
        ...replaceResult,
        result: undefined,
        attempts: 1,
      })),
      replaceConfigFile: scope.capture(async () => replaceResult),
    } satisfies PluginRuntime["config"];
    const runtime = createPluginRuntime();
    runtime.config = configRuntime;
    const builder = createRuntimeTestRegistry(runtime);
    const record = createRecord("legacy-plugin", { name: "Legacy Plugin" });
    const api = builder.createApi(record, { config });

    expect(api.runtime.config.current()).toBe(config);
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "none", reason: "test" },
      mutate: () => undefined,
    });
    await api.runtime.config.replaceConfigFile({
      nextConfig: config,
      afterWrite: { mode: "none", reason: "test" },
    });

    scope.expectOwner("legacy-plugin", 3);
  });

  it("runs local service acquisition with the owning plugin scope", async () => {
    const scope = scopeCapture();
    const runtime = createPluginRuntime();
    runtime.llm.acquireLocalService = vi.fn(scope.capture(async () => undefined));
    const { api } = registered(
      "memory-provider",
      { name: "Memory Provider", origin: "bundled" },
      runtime,
    );

    await api.runtime.llm.acquireLocalService({
      providerId: "gpu-host",
      baseUrl: "http://127.0.0.1:11434",
    });

    scope.expectOwner("memory-provider", 1);
  });

  it("keeps scoped LLM acquisition lazy and rejects retained calls after retirement", async () => {
    const resolveRuntime = vi
      .spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics")
      .mockImplementation(() => {
        throw new Error("scoped LLM acquisition must not load the broad runtime");
      });
    const runtime = createLazyPluginRuntime({ pluginSdkResolution: "src" });
    const { builder, api } = registered("local-service-owner", {}, runtime);
    const target = { providerId: "fixture", baseUrl: "https://provider.example.invalid" };
    setRuntimeConfigSnapshot({
      models: { providers: { fixture: { baseUrl: target.baseUrl, models: [] } } },
    });
    try {
      markPluginRegistryActive(builder.registry);
      const { acquireLocalService } = api.runtime.llm;
      await expect(acquireLocalService(target)).resolves.toBeUndefined();
      markPluginRegistryRetired(builder.registry);
      clearRuntimeConfigSnapshot();
      expect(() => acquireLocalService(target)).toThrow("runtime is no longer active");
      expect(resolveRuntime).not.toHaveBeenCalled();
    } finally {
      markPluginRegistryRetired(builder.registry);
      clearRuntimeConfigSnapshot();
    }
  });

  it("runs lazy node helpers with the owning plugin scope", async () => {
    const scope = scopeCapture();
    const nodes: PluginRuntime["nodes"] = {
      list: vi.fn(scope.capture(async () => ({ nodes: [] }))),
      invoke: vi.fn(scope.capture(async () => ({ ok: true }))),
      openDuplex: vi.fn(
        scope.capture(async () => ({
          send: vi.fn(async () => {}),
          onMessage: vi.fn(() => () => {}),
          closed: Promise.resolve({ ok: true }),
          close: vi.fn(),
        })),
      ),
    };
    const resolveRuntimeModule = vi
      .spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics")
      .mockImplementation(() => {
        throw new Error("broad runtime should stay lazy during scoped node access");
      });
    const runtime = createLazyPluginRuntime({ runtimeOptions: { nodes } });
    const { builder, api } = registered(
      "google-meet",
      { name: "Google Meet", origin: "bundled" },
      runtime,
    );

    await api.runtime.nodes.list({ connected: true });
    await api.runtime.nodes.invoke({
      nodeId: "node-1",
      command: "browser.proxy",
      scopes: ["operator.admin"],
    });
    await api.runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" });

    scope.expectOwner("google-meet", 3);
    expect(scope.scopes[2]?.pluginRegistry).toBe(builder.registry);
    expect(resolveRuntimeModule).not.toHaveBeenCalled();
  });

  it("runs gateway requests with the owning plugin scope", async () => {
    const scope = scopeCapture();
    const runtime = createPluginRuntime();
    runtime.gateway.isAvailable = async () => true;
    vi.spyOn(runtime.gateway, "request").mockImplementation(
      scope.capture(async () => ({ ok: true })),
    );
    const { api } = registered("google-meet", { name: "Google Meet", origin: "bundled" }, runtime);

    await api.runtime.gateway.request("voicecall.start", { to: "+15550001234" });

    scope.expectOwner("google-meet", 1);
    expect(scope.scopes[0]?.pluginOrigin).toBe("bundled");
  });

  it("limits harness session creation to the registering plugin", async () => {
    const { builder, api: ownerApi, createSessionEntry } = sessionFixture("codex-owner");
    let createScope = getPluginRuntimeGatewayRequestScope();
    createSessionEntry.mockImplementation(async (params) => {
      createScope = getPluginRuntimeGatewayRequestScope();
      const entry = {
        sessionId: "session-1",
        updatedAt: 1,
        agentHarnessId: "codex",
      };
      return { key: params.key, agentId: "main", sessionId: entry.sessionId, entry };
    });
    const otherRecord = createRecord("other-plugin", { origin: "bundled" });
    const otherApi = builder.createApi(otherRecord, { config: {} });
    ownerApi.registerAgentHarness(createHarness("codex"));
    const createParams = {
      cfg: {},
      key: "agent:main:harness:codex:thread-1",
      initialEntry: { agentHarnessId: "codex" },
    };

    await expect(ownerApi.runtime.agent.session.createSessionEntry(createParams)).resolves.toEqual(
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(createScope).toMatchObject({
      pluginId: "codex-owner",
      pluginSource: "/plugins/codex-owner/index.js",
    });
    const ordinaryParams = {
      cfg: {},
      key: "agent:main:ordinary",
      initialEntry: { agentHarnessId: "codex", modelSelectionLocked: true },
    } satisfies CreateParams;
    for (const params of [createParams, ordinaryParams]) {
      await expect(otherApi.runtime.agent.session.createSessionEntry(params)).rejects.toThrow(
        'Agent harness "codex" is owned by plugin "codex-owner", not "other-plugin".',
      );
    }
    await expect(
      ownerApi.runtime.agent.session.createSessionEntry(ordinaryParams),
    ).resolves.toEqual(expect.objectContaining({ sessionId: "session-1" }));
    expect(createSessionEntry).toHaveBeenCalledTimes(2);
  });

  it("limits CLI session creation to the owning plugin namespace", async () => {
    const fixture = sessionFixture("anthropic");
    fixture.api.registerCliBackend({ id: "claude-cli", config: { command: "claude" } });
    fixture.api.registerAgentHarness(createHarness("anthropic-harness"));
    const initialEntry = {
      cliBackendId: "claude-cli",
      model: "claude-opus-4-8",
      modelSelectionLocked: true as const,
      cliSessionBinding: { sessionId: "source", forkNextResume: true as const },
    };

    await expectSessionNamespace(
      fixture,
      "plugin:anthropic:catalog-adopt:claude:source",
      initialEntry,
      {
        cfg: {},
        key: "agent:main:ordinary",
        initialEntry: { ...initialEntry, agentHarnessId: "anthropic-harness" } as never,
      },
    );
  });

  it("limits ACP session creation to the calling plugin namespace", async () => {
    const fixture = sessionFixture("opencode");
    const initialEntry = {
      acpBackendId: "acpx",
      acpSessionBinding: {
        acpAgentId: "opencode",
        agentSessionId: "source",
      },
    };

    await expectSessionNamespace(fixture, "plugin:opencode:catalog-adopt:source", initialEntry, {
      cfg: {},
      key: "plugin:opencode:catalog-adopt:source",
      initialEntry: { ...initialEntry, cliBackendId: "opencode" } as never,
    });
  });

  it.each(["patchSessionEntry", "updateSessionStoreEntry"] as const)(
    "rejects %s writes resumed after their plugin is replaced",
    async (method) => {
      let entry: SessionEntry = { sessionId: "session-1", updatedAt: 1, label: "before" };
      const commitPatch = (patch: Partial<SessionEntry> | null) => {
        if (patch) {
          entry = { ...entry, ...patch };
        }
        return entry;
      };
      const runtime = createPluginRuntime();
      runtime.agent.session.getSessionEntryAsync = async () => ({ ...entry });
      runtime.agent.session.patchSessionEntry = async (params) =>
        commitPatch(await params.update({ ...entry }, { existingEntry: { ...entry } }));
      runtime.agent.session.updateSessionStoreEntry = async (params) =>
        commitPatch(await params.update({ ...entry }));
      const { builder, record, api } = registered("session-editor", {}, runtime);
      const entered = createDeferredCore();
      const resume = createDeferredCore<Partial<SessionEntry>>();
      const scope = { sessionKey: "agent:main:ordinary", storePath: "/tmp/sessions.json" };
      try {
        const pending = api.runtime.agent.session[method]({
          ...scope,
          update: () => {
            entered.resolve();
            return resume.promise;
          },
        });
        await entered.promise;
        builder.rollbackPluginGlobalSideEffects(record.id, record);
        builder.registry.plugins.splice(0, 1);
        const replacementApi = builder.createApi(createRecord(record.id), {
          config: {},
        });
        const rejected = expect(pending).rejects.toThrow("runtime is no longer active");
        resume.resolve({ label: "stale" });
        await rejected;
        expect(entry.label).toBe("before");

        await expect(
          replacementApi.runtime.agent.session[method]({
            ...scope,
            update: () => ({ label: "current" }),
          }),
        ).resolves.toMatchObject({ label: "current" });
        expect(entry.label).toBe("current");
      } finally {
        resume.resolve({});
        await getPluginInstance(record)?.dispose();
        await disposePluginRegistryInstances(builder.registry);
      }
    },
  );
});

it.each(["bundled", "global", "config", "workspace"] as const)(
  "derives queue input semantics from the exact %s registrar owner, not its codex ID",
  async (origin) => {
    const { builder, api } = registered("codex", { origin });
    api.registerAgentHarness(createHarness("codex"));
    await withPluginRuntimeRegistryScope(builder.registry, async () => {
      const registeredHarness = listRegisteredAgentHarnesses()[0]?.harness;
      expect(registeredHarness).toBeDefined();
      if (!registeredHarness) {
        throw new Error("Expected registrar-owned fixture harness");
      }
      expect(resolveAgentHarnessQueueInputAdapter(registeredHarness)).toBe(
        origin === "bundled" ? "human-and-question-permission" : "legacy-question-category",
      );
      // A replacement object with the same public fields is not that registration.
      expect(() => resolveAgentHarnessQueueInputAdapter({ ...registeredHarness })).toThrow(
        "changed during input adapter resolution",
      );
    });
  },
);

it("keeps direct facade registrations legacy even beside a bundled same-ID record", async () => {
  const { builder } = registered("codex", { origin: "bundled" });
  await withPluginRuntimeRegistryScope(builder.registry, async () => {
    registerAgentHarness(createHarness("codex"), { ownerPluginId: "codex" });
    const harness = listRegisteredAgentHarnesses()[0]?.harness;
    if (!harness) {
      throw new Error("Expected direct facade harness");
    }
    expect(resolveAgentHarnessQueueInputAdapter(harness)).toBe("legacy-question-category");
  });
});

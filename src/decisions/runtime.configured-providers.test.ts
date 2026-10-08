import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  evaluateDecisionInRegistry,
  inspectDecisionProviders,
  prepareDecisionProviderReload,
} from "./runtime.js";
import type { DecisionProviderV1, ProviderDecisionOutcome } from "./types.js";

const batch = { state: "synthetic", questions: { check: { type: "boolean" as const } } };
const answer: ProviderDecisionOutcome = {
  status: "ok",
  result: { model: "custom-v1", answers: { check: { type: "boolean", probabilityTrue: 1 } } },
};
const options = () => ({
  purpose: "test",
  rubricVersion: "1",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
});
const endpoint = (id = "judge"): ModelProviderConfig => ({
  type: "decision",
  decisionProvider: "wire",
  baseUrl: `https://${id}.example.test/decisions`,
  apiKey: `synthetic-${id}-key`,
  headers: { "X-Decision-Tenant": `synthetic-${id}` },
  authHeader: true,
  timeoutSeconds: 3,
  models: [
    {
      id: "custom-v1",
      name: "Custom decision model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 0,
    },
  ],
});

type WireRequest = {
  id: string;
  config: NonNullable<
    ReturnType<
      Parameters<NonNullable<DecisionProviderV1["createConfiguredProvider"]>>[0]["getConfig"]
    >
  >;
  context: Parameters<DecisionProviderV1["evaluate"]>[1];
};

function fixture(
  params: {
    providers?: Record<string, ModelProviderConfig>;
    wire?: (request: WireRequest) => Promise<ProviderDecisionOutcome>;
    factory?: DecisionProviderV1["createConfiguredProvider"] | false;
    adapterIds?: string[];
  } = {},
) {
  let config: OpenClawConfig = {
    agents: { defaults: { decisionModel: "judge/custom-v1" } },
    models: { providers: params.providers ?? { judge: endpoint() } },
    plugins: { entries: { owner: { enabled: true } } },
  };
  setRuntimeConfigSnapshot(config);
  // Registration reads only this fixture's canonical config; no production runtime is booted.
  const builder = createTestPluginRegistry({
    config: { current: () => config },
  } as PluginRuntime);
  const record = createPluginRecord({
    id: "owner",
    source: "/synthetic/index.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: params.adapterIds ?? ["wire"] },
  });
  const fallback = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
  const wire = vi.fn(params.wire ?? (async (_request: WireRequest) => answer));
  const createConfiguredProvider: NonNullable<DecisionProviderV1["createConfiguredProvider"]> =
    params.factory ||
    (({ id, getConfig }) => ({
      id,
      contractVersion: 1,
      isReady: () => typeof getConfig()?.apiKey === "string",
      async evaluate(_batch, context) {
        const settings = getConfig();
        if (!settings || typeof settings.apiKey !== "string") {
          return { status: "unavailable", reason: "credentials-unavailable" };
        }
        if (!context.isAdmissible?.()) {
          return { status: "unavailable", reason: "transport" };
        }
        return wire({ id, config: settings, context });
      },
    }));
  const api = builder.createApi(record, { config });
  const register = (provider: DecisionProviderV1) =>
    runPluginRegisterSyncInRegistry(
      (registration) => registration.registerDecisionProvider(provider),
      api,
      builder.registry,
      record.id,
    );
  register({
    id: "wire",
    contractVersion: 1,
    evaluate: fallback,
    ...(params.factory !== false ? { createConfiguredProvider } : {}),
  });
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  onTestFinished(async () => {
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  const update = (next: OpenClawConfig) => {
    config = next;
    setRuntimeConfigSnapshot(config);
  };
  const select = (id: string, model = "custom-v1") =>
    update({ ...config, agents: { defaults: { decisionModel: `${id}/${model}` } } });
  return {
    ...builder,
    record,
    wire,
    fallback,
    register,
    update,
    select,
    config: () => config,
    inspect: () => inspectDecisionProviders(config, builder.registry),
    run: (opts = options()) => evaluateDecisionInRegistry(batch, opts, builder.registry, config),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

describe("registered configured decision endpoints", () => {
  it("keeps an adapter usable when its native ID is a configured alias of another adapter", async () => {
    const host = fixture({
      adapterIds: ["wire", "other-wire"],
      providers: {
        "other-wire": endpoint("other-wire"),
        judge: { ...endpoint(), decisionProvider: "other-wire" },
      },
    });
    const factory = vi.fn<NonNullable<DecisionProviderV1["createConfiguredProvider"]>>(
      ({ id }) => ({
        id,
        contractVersion: 1,
        evaluate: async () => answer,
      }),
    );
    host.register({
      id: "other-wire",
      contractVersion: 1,
      evaluate: async () => answer,
      createConfiguredProvider: factory,
    });
    expect(factory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "judge" }));
    expect(host.registry.decisionProviders.map((entry) => entry.host.provider.id)).toEqual([
      "wire",
      "other-wire",
      "judge",
    ]);
    expect(await host.run()).toMatchObject({ status: "ok", provenance: { providerId: "judge" } });
  });

  it.each([false, true])(
    "rejects duplicate adapters before expanding aliases (factory: %s)",
    async (supportsFactory) => {
      const host = fixture({ factory: supportsFactory ? undefined : false });
      const duplicate = createPluginRecord({
        id: "duplicate-owner",
        source: "/synthetic/duplicate.ts",
        origin: "global",
        enabled: true,
        configSchema: false,
        contracts: { decisionProviders: ["wire"] },
      });
      const factory = vi.fn<NonNullable<DecisionProviderV1["createConfiguredProvider"]>>(
        ({ id }) => ({
          id,
          contractVersion: 1,
          evaluate: async () => answer,
        }),
      );
      const api = host.createApi(duplicate, { config: host.config() });
      host.registry.plugins.push(duplicate);
      onTestFinished(async () => {
        prepareDecisionProviderReload(host.registry, new Set([duplicate.id]));
        await getPluginInstance(duplicate)?.dispose();
      });
      runPluginRegisterSyncInRegistry(
        (registration) =>
          registration.registerDecisionProvider({
            id: "wire",
            contractVersion: 1,
            evaluate: async () => answer,
            createConfiguredProvider: factory,
          }),
        api,
        host.registry,
        duplicate.id,
      );
      expect(factory).not.toHaveBeenCalled();
      expect(host.registry.decisionProviders.every((entry) => entry.pluginId === "owner")).toBe(
        true,
      );
      expect(host.registry.diagnostics).toContainEqual(
        expect.objectContaining({
          pluginId: duplicate.id,
          message: "decision provider already registered: wire",
        }),
      );
    },
  );

  it("dispatches a custom ID and model with the configured endpoint and credentials", async () => {
    const host = fixture();
    expect(await host.run()).toMatchObject({
      status: "ok",
      provenance: { providerId: "judge" },
    });
    expect(host.wire).toHaveBeenCalledExactlyOnceWith({
      id: "judge",
      config: expect.objectContaining({
        baseUrl: "https://judge.example.test/decisions",
        apiKey: "synthetic-judge-key",
        headers: { "X-Decision-Tenant": "synthetic-judge" },
        authHeader: true,
        timeoutSeconds: 3,
      }),
      context: expect.objectContaining({ model: "custom-v1", isAdmissible: expect.any(Function) }),
    });
    expect(
      host.registry.decisionProviders.find((entry) => entry.host.provider.id === "judge"),
    ).toMatchObject({ pluginId: "owner", host: { configuredAdapterId: "wire" } });
    expect(host.fallback).not.toHaveBeenCalled();
  });

  it("does not use plugin credentials when an explicitly configured native ID lacks a key", async () => {
    const configured = endpoint("wire");
    delete configured.apiKey;
    const host = fixture({ providers: { wire: configured } });
    host.select("wire");
    expect(await host.run()).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
    expect(host.registry.decisionProviders.map((entry) => entry.host.provider.id)).toEqual([
      "wire",
    ]);
    expect(host.wire).not.toHaveBeenCalled();
    expect(host.fallback).not.toHaveBeenCalled();
  });

  it.each(["undeclared model", "removed adapter", "removed endpoint"])(
    "fails closed for an %s without calling a fallback",
    async (change) => {
      const host = fixture();
      if (change === "undeclared model") {
        host.select("judge", "not-listed");
      } else {
        const providers = structuredClone(host.config().models!.providers!);
        if (change === "removed adapter") {
          providers.judge!.decisionProvider = "absent";
        } else {
          delete providers.judge;
        }
        host.update({ ...host.config(), models: { providers } });
      }
      expect(await host.run()).toEqual({ status: "unavailable", reason: "not-configured" });
      expect(host.wire).not.toHaveBeenCalled();
      expect(host.fallback).not.toHaveBeenCalled();
    },
  );

  it("keeps configured aliases' auth circuits and diagnostics independent", async () => {
    const host = fixture({
      providers: { judge: endpoint(), second: endpoint("second") },
      wire: async ({ id }) =>
        id === "judge" ? { status: "unavailable", reason: "authentication" } : answer,
    });
    expect(await host.run()).toEqual({ status: "unavailable", reason: "authentication" });
    host.select("second");
    expect(await host.run()).toMatchObject({ status: "ok", provenance: { providerId: "second" } });
    host.select("judge");
    expect(await host.run()).toEqual({ status: "unavailable", reason: "circuit-open" });
    expect(host.wire).toHaveBeenCalledTimes(2);
    expect(host.inspect()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "judge", callable: false, successCount: 0 }),
        expect.objectContaining({ providerId: "second", successCount: 1, reasons: {} }),
      ]),
    );
  });

  it.each(["baseUrl", "apiKey"] as const)(
    "resets an auth circuit when the configured %s changes",
    async (field) => {
      const host = fixture();
      host.wire.mockResolvedValueOnce({ status: "unavailable", reason: "authentication" });
      expect(await host.run()).toMatchObject({ reason: "authentication" });
      expect(await host.run()).toMatchObject({ reason: "circuit-open" });
      const before = host.inspect().find((entry) => entry.providerId === "judge")!;
      const providers = structuredClone(host.config().models!.providers!);
      providers.judge![field] =
        field === "baseUrl" ? "https://updated.example.test" : "synthetic-new-key";
      host.update({ ...host.config(), models: { providers } });
      expect(await host.run()).toMatchObject({ status: "ok" });
      expect(
        host.inspect().find((entry) => entry.providerId === "judge")!.runtimeGeneration,
      ).not.toBe(before.runtimeGeneration);
      expect(host.wire).toHaveBeenCalledTimes(2);
      expect(host.wire.mock.calls[1]![0].config[field]).toBe(providers.judge![field]);
    },
  );

  it.each(["baseUrl", "apiKey"] as const)(
    "fences in-flight admission and the response after %s changes",
    async (field) => {
      const entered = createDeferredCore<WireRequest>();
      const release = createDeferredCore();
      const host = fixture({
        wire: async (request) => {
          entered.resolve(request);
          await release.promise;
          return answer;
        },
      });
      const pending = host.run();
      const request = await entered.promise;
      const providers = structuredClone(host.config().models!.providers!);
      providers.judge![field] =
        field === "baseUrl" ? "https://updated.example.test" : "synthetic-new-key";
      host.update({ ...host.config(), models: { providers } });
      expect(request.context.isAdmissible?.()).toBe(false);
      release.resolve();
      expect(await pending).toEqual({ status: "unavailable", reason: "retiring" });
      expect(host.inspect().find((entry) => entry.providerId === "judge")).toMatchObject({
        activeRequests: 0,
        successCount: 0,
      });
    },
  );

  it("closes configured aliases when the owning plugin is disabled", async () => {
    const entered = createDeferredCore<WireRequest>();
    const release = createDeferredCore();
    const host = fixture({
      wire: async (request) => {
        entered.resolve(request);
        await release.promise;
        return answer;
      },
    });
    const pending = host.run();
    const request = await entered.promise;
    host.update({ ...host.config(), plugins: { entries: { owner: { enabled: false } } } });
    expect(request.context.isAdmissible?.()).toBe(false);
    release.resolve();
    expect(await pending).toEqual({ status: "unavailable", reason: "retiring" });
    expect(await host.run()).toEqual({ status: "unavailable", reason: "disabled" });
    expect(host.wire).toHaveBeenCalledTimes(1);
  });

  it("preserves caller cancellation for a configured alias and joins its callback", async () => {
    const entered = createDeferredCore();
    let settled = false;
    const host = fixture({
      wire: async ({ context }) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
          entered.resolve();
        });
        settled = true;
        return answer;
      },
    });
    const caller = new AbortController();
    const pending = host.run({ ...options(), signal: caller.signal });
    await entered.promise;
    caller.abort(new Error("synthetic caller replaced"));
    await expect(pending).rejects.toThrow("synthetic caller replaced");
    expect(settled).toBe(true);
    expect(host.inspect().find((entry) => entry.providerId === "judge")).toMatchObject({
      activeRequests: 0,
      successCount: 0,
    });
  });

  it("rejects a configured factory's mismatched ID", async () => {
    const host = fixture({
      factory: () => ({ id: "other", contractVersion: 1, evaluate: async () => answer }),
    });
    expect(await host.run()).toEqual({ status: "unavailable", reason: "not-configured" });
    expect(host.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "invalid configured decision provider contract" }),
      ]),
    );
    expect(host.registry.decisionProviders.map((entry) => entry.host.provider.id)).toEqual([
      "wire",
    ]);
  });

  it("requires manifest ownership for direct alias registration", async () => {
    const host = fixture({
      factory: () => {
        throw new Error("synthetic unavailable adapter");
      },
    });
    const unowned = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    host.register({ id: "judge", contractVersion: 1, evaluate: unowned });
    expect(await host.run()).toEqual({ status: "unavailable", reason: "not-configured" });
    expect(host.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "decision provider must declare contracts.decisionProviders ownership",
        }),
      ]),
    );
    expect(unowned).not.toHaveBeenCalled();
  });
});

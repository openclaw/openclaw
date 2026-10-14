import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { PluginInstance } from "./plugin-instance.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";
import { startPluginServices } from "./services.test-support.js";
import type { OpenClawPluginApi } from "./types.js";

const registries: ReturnType<typeof createTestPluginRegistry>["registry"][] = [];

afterEach(async () => {
  await clearActivePluginRegistry();
  for (const registry of registries.splice(0)) {
    await disposePluginRegistryInstances(registry);
  }
});

function createRegistrationFixture() {
  const builder = createTestPluginRegistry();
  registries.push(builder.registry);
  const createRecord = (
    id: string,
    fields: Partial<Parameters<typeof createPluginRecord>[0]> = {},
  ) => {
    const record = createPluginRecord({
      id,
      source: `/plugins/${id}/index.ts`,
      origin: "global",
      enabled: true,
      configSchema: false,
      ...fields,
    });
    builder.registry.plugins.push(record);
    return record;
  };
  const createPlugin = (id: string, fields?: Parameters<typeof createRecord>[1]) => {
    const record = createRecord(id, fields);
    return { record, api: builder.createApi(record, { config: {} }) };
  };
  return { builder, registry: builder.registry, createRecord, createPlugin };
}

describe("plugin registration diagnostics", () => {
  it("preserves ordered severity and call-time provenance across registrars and rollback", () => {
    const { builder, registry, createPlugin } = createRegistrationFixture();
    const { record: alpha, api: alphaApi } = createPlugin("alpha");
    const { record: beta, api: betaApi } = createPlugin("beta");
    const alphaSource = "/plugins/alpha/resolved.ts";
    const betaSource = "/plugins/beta/index.ts";
    alpha.source = alphaSource;

    alphaApi.registerService({ id: "", start() {} });
    betaApi.registerContextEngine("", () => {
      throw new Error("invalid registration must not instantiate its factory");
    });
    alphaApi.registerReload({});
    betaApi.registerTextTransforms({});
    // @ts-expect-error JavaScript plugins may omit the required supplement builder.
    alphaApi.registerMemoryPromptSupplement(undefined);
    // @ts-expect-error JavaScript plugins may omit the required hosted-media resolver.
    betaApi.registerHostedMediaResolver(undefined);
    // @ts-expect-error Unknown JavaScript hook names must produce a diagnostic.
    alphaApi.on("unknown-hook", () => {});
    betaApi.registerRuntimeLifecycle({ id: "" });

    const expected = [
      ["error", "alpha", alphaSource, "service registration missing id"],
      ["error", "beta", betaSource, "context engine registration missing id"],
      ["warn", "alpha", alphaSource, "reload registration missing prefixes"],
      [
        "warn",
        "beta",
        betaSource,
        "text transform registration has no input or output replacements",
      ],
      ["error", "alpha", alphaSource, "memory prompt supplement registration missing builder"],
      ["error", "beta", betaSource, "hosted media resolver registration missing resolver"],
      ["warn", "alpha", alphaSource, 'unknown typed hook "unknown-hook" ignored'],
      ["error", "beta", betaSource, "runtime lifecycle registration missing id"],
    ].map(([level, pluginId, source, message]) => ({ level, pluginId, source, message }));
    expect(registry.diagnostics).toEqual(expected);
    expect(registry.services).toEqual([]);
    expect(registry.contextEngines.size).toBe(0);
    expect(registry.reloads).toEqual([]);
    expect(registry.textTransforms).toEqual([]);
    expect(registry.memoryPromptSupplements).toEqual([]);
    expect(registry.hostedMediaResolvers).toEqual([]);
    expect(registry.typedHooks).toEqual([]);
    expect(registry.runtimeLifecycles).toEqual([]);

    alpha.source = "/plugins/alpha/later.ts";
    alphaApi.registerService({ id: "alpha-service", start() {} });
    betaApi.registerService({ id: "beta-service", start() {} });
    expect(registry.services.map((entry) => entry.pluginId)).toEqual(["alpha", "beta"]);
    builder.rollbackPluginGlobalSideEffects(alpha.id, alpha);
    expect(registry.services.map((entry) => entry.pluginId)).toEqual(["beta"]);
    builder.rollbackPluginGlobalSideEffects(beta.id, beta);
    expect(registry.services).toEqual([]);
    expect(registry.diagnostics).toEqual(expected);
  });

  it("keeps provider and catalog ownership unchanged after blank and duplicate registration", async () => {
    const { registry, createPlugin } = createRegistrationFixture();
    const { record: alpha, api: alphaApi } = createPlugin("alpha", {
      contracts: { speechProviders: ["shared-speech"] },
    });
    const { record: beta, api: betaApi } = createPlugin("beta");
    const speech = {
      id: "shared-speech",
      label: "Shared speech",
      models: ["speech-model"],
      isConfigured: () => true,
      synthesize: vi.fn(async () => ({
        audioBuffer: Buffer.from("alpha audio"),
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      })),
    } satisfies Parameters<OpenClawPluginApi["registerSpeechProvider"]>[0];
    const media = { id: "shared-media" };
    alphaApi.registerSpeechProvider(speech);
    alphaApi.registerMediaUnderstandingProvider(media);

    betaApi.registerSpeechProvider({ ...speech, id: " " });
    betaApi.registerSpeechProvider({
      ...speech,
      label: "Rejected replacement",
      isConfigured: () => false,
    });
    betaApi.registerMediaUnderstandingProvider({ id: " " });
    betaApi.registerMediaUnderstandingProvider({ ...media });

    expect(registry.diagnostics).toEqual(
      [
        "speech provider registration missing id",
        "speech provider already registered: shared-speech (alpha)",
        "media provider registration missing id",
        "media provider already registered: shared-media (alpha)",
      ].map((message) => ({
        level: "error",
        pluginId: "beta",
        source: "/plugins/beta/index.ts",
        message,
      })),
    );
    expect(
      registry.speechProviders.map(({ pluginId, provider }) => ({ pluginId, provider })),
    ).toEqual([
      {
        pluginId: "alpha",
        provider: expect.objectContaining({
          id: "shared-speech",
          label: "Shared speech",
          models: ["speech-model"],
        }),
      },
    ]);
    expect(speech.synthesize).not.toHaveBeenCalled();
    setActivePluginRegistry(registry);
    const registeredSpeech = registry.speechProviders[0]!.provider;
    expect(registeredSpeech.isConfigured({ providerConfig: {}, timeoutMs: 1_000 })).toBe(true);
    await expect(
      registeredSpeech.synthesize({
        text: "test",
        cfg: {},
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      audioBuffer: Buffer.from("alpha audio"),
      outputFormat: "wav",
      fileExtension: ".wav",
      voiceCompatible: false,
    });
    expect(speech.synthesize).toHaveBeenCalledOnce();
    expect(
      registry.mediaUnderstandingProviders.map(({ pluginId, provider }) => ({
        pluginId,
        provider,
      })),
    ).toEqual([{ pluginId: "alpha", provider: media }]);
    expect(alpha.speechProviderIds).toEqual(["shared-speech"]);
    expect(alpha.mediaUnderstandingProviderIds).toEqual(["shared-media"]);
    expect(beta.speechProviderIds).toEqual([]);
    expect(beta.mediaUnderstandingProviderIds).toEqual([]);
    expect(
      registry.modelCatalogProviders.map(({ pluginId, provider }) => ({
        pluginId,
        provider: provider.provider,
        kinds: provider.kinds,
      })),
    ).toEqual([{ pluginId: "alpha", provider: "shared-speech", kinds: ["voice"] }]);
  });

  it("keeps reentrant diagnostics host-owned and stops coercion after registration throws", () => {
    const { registry, createPlugin } = createRegistrationFixture();
    const { record, api: ownerApi } = createPlugin("owner");
    let captured: OpenClawPluginApi | undefined;
    let coercions = 0;
    // Exercise the existing unknown-hook path for untyped plugin input, not host-record accessors.
    const hookName = {
      toString() {
        coercions += 1;
        const api = expectDefined(captured, "captured registration API");
        api.id = "plugin-copy";
        api.source = "/plugins/plugin-copy.ts";
        api.registerReload({});
        return "unknown-hook";
      },
    };
    const register = () =>
      runPluginRegisterSyncInRegistry(
        (api) => {
          captured = api;
          // @ts-expect-error Untyped hook input reaches the existing rejection/coercion path.
          api.on(hookName, () => {});
          throw new Error("registration failed");
        },
        ownerApi,
        registry,
        record.id,
      );
    expect(register).toThrow("registration failed");

    const expected = [
      "reload registration missing prefixes",
      'unknown typed hook "unknown-hook" ignored',
    ].map((message) => ({
      level: "warn",
      pluginId: "owner",
      source: "/plugins/owner/index.ts",
      message,
    }));
    expect(registry.diagnostics).toEqual(expected);
    expect(record.id).toBe("owner");
    expect(record.source).toBe("/plugins/owner/index.ts");
    const retained = expectDefined(captured, "captured registration API");
    // @ts-expect-error Closed registration must stop before coercing untyped hook input.
    expect(retained.on(hookName, () => {})).toBeUndefined();
    expect(coercions).toBe(1);
    expect(registry.diagnostics).toEqual(expected);
    expect(registry.typedHooks).toEqual([]);
    expect(registry.reloads).toEqual([]);
  });
});

class ClassBackedLifecycleService {
  starts = 0;

  constructor(readonly id: string) {}

  start() {
    this.starts += 1;
  }
}

describe("plugin service registration identity", () => {
  it("preserves native service descriptors through canonical reload and cleanup", async () => {
    const { builder, createRecord } = createRegistrationFixture();
    const record = createRecord("native-service-owner");
    const instance = new PluginInstance(record.id, { record, registry: builder.registry });
    const store = createPluginRuntimeStore<object>("native service runtime missing");
    const runtime = {};
    const calls: Array<{ phase: string; value: number; runtime: object | null }> = [];
    class NativeService extends Date {
      readonly id = "native-service";
      start() {
        calls.push({ phase: "start", value: this.getTime(), runtime: store.tryGetRuntime() });
      }
      stop() {
        calls.push({ phase: "stop", value: this.getTime(), runtime: store.tryGetRuntime() });
      }
    }
    const service = new NativeService(37);
    let reads = 0;
    Object.defineProperty(service, "id", {
      get() {
        if (reads++ > 0) {
          throw new Error("service id must only be read at admission");
        }
        return " native-service ";
      },
    });
    instance.run(() => {
      store.setRuntime(runtime);
      builder.createApi(record, { config: {} }).registerService(service);
    });
    expect(builder.registry.services).toHaveLength(1);
    expect(builder.registry.services[0]?.service).toBe(service);
    expect(record.services).toEqual(["native-service"]);
    const services = await startPluginServices({ registry: builder.registry, config: {} });
    try {
      await services.reload({}, new Set(["native-service"]));
      await services.stop();
      expect(calls).toEqual([
        { phase: "start", value: 37, runtime },
        { phase: "stop", value: 37, runtime },
        { phase: "start", value: 37, runtime },
        { phase: "stop", value: 37, runtime },
      ]);
      expect(calls.every((call) => call.runtime === runtime)).toBe(true);
    } finally {
      await services.stop();
    }
  });

  it("contains unreadable IDs without leaking accessor errors", () => {
    const { builder, createRecord } = createRegistrationFixture();
    const record = createRecord("unreadable-owner");
    const api = builder.createApi(record, { config: {} });
    const service = {
      get id(): string {
        throw new Error("private accessor failure");
      },
      start() {},
      advertise() {},
    };
    expect(() => api.registerService(service)).not.toThrow();
    expect(() => api.registerGatewayDiscoveryService(service)).not.toThrow();
    expect(builder.registry.services).toEqual([]);
    expect(builder.registry.gatewayDiscoveryServices).toEqual([]);
    expect(builder.registry.diagnostics.map(({ message }) => message)).toEqual([
      "service registration id cannot be normalized",
      "gateway discovery service registration id cannot be normalized",
    ]);
  });

  it("snapshots each namespace independently without writing plugin accessors", () => {
    const { builder, createRecord } = createRegistrationFixture();
    const record = createRecord("shared-owner");
    const api = builder.createApi(record, { config: {} });
    let rawId = " shared-service ";
    class Service extends Date {
      get id() {
        return rawId;
      }
      set id(_value: string) {
        throw new Error("must not write plugin-owned IDs");
      }
      start() {}
      advertise() {}
    }
    const service = new Service();
    api.registerService(service);
    api.registerGatewayDiscoveryService(service);
    rawId = "changed-after-registration";
    api.registerService({ id: "shared-service", start() {} });
    api.registerGatewayDiscoveryService({ id: "shared-service", advertise() {} });
    expect(builder.registry.services).toHaveLength(1);
    expect(builder.registry.gatewayDiscoveryServices).toHaveLength(1);
    for (const entry of [
      ...builder.registry.services,
      ...builder.registry.gatewayDiscoveryServices,
    ]) {
      expect(entry.id).toBe("shared-service");
      expect(entry.service).toBe(service);
    }
    expect(record.services).toEqual(["shared-service"]);
    expect(record.gatewayDiscoveryServiceIds).toEqual(["shared-service"]);
    expect(builder.registry.diagnostics).toEqual([]);
  });

  it("retains the first service when a different owner claims its normalized ID", async () => {
    const { builder, createRecord } = createRegistrationFixture();
    const first = createRecord("first-owner");
    const second = createRecord("second-owner");
    const firstService = new ClassBackedLifecycleService(" shared-service ");
    const secondService = new ClassBackedLifecycleService("shared-service");
    builder.createApi(first, { config: {} }).registerService(firstService);
    builder.createApi(second, { config: {} }).registerService(secondService);
    expect(builder.registry.services).toEqual([
      expect.objectContaining({
        pluginId: first.id,
        source: first.source,
        id: "shared-service",
        service: firstService,
      }),
    ]);
    expect(first.services).toEqual(["shared-service"]);
    expect(second.services).toEqual([]);
    expect(builder.registry.diagnostics).toEqual([
      expect.objectContaining({
        pluginId: second.id,
        message: "service already registered: shared-service (first-owner)",
      }),
    ]);
    setActivePluginRegistry(builder.registry);
    const handle = await startPluginServices({ registry: builder.registry, config: {} });
    try {
      expect(firstService.starts).toBe(1);
      expect(secondService.starts).toBe(0);
    } finally {
      await handle.stop();
    }
  });
});

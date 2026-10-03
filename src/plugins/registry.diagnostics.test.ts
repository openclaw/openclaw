import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";
import type { OpenClawPluginApi } from "./types.js";

const registries: ReturnType<typeof createTestPluginRegistry>["registry"][] = [];

afterEach(async () => {
  await clearActivePluginRegistry();
  for (const registry of registries.splice(0)) {
    await disposePluginRegistryInstances(registry);
  }
});

function createDiagnosticFixture() {
  const builder = createTestPluginRegistry();
  registries.push(builder.registry);
  const createPlugin = (id: string) => {
    const record = createPluginRecord({
      id,
      source: `/plugins/${id}/index.ts`,
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    builder.registry.plugins.push(record);
    return { record, api: builder.createApi(record, { config: {} }) };
  };
  return { builder, registry: builder.registry, createPlugin };
}

describe("plugin registration diagnostics", () => {
  it("preserves ordered severity and call-time provenance across registrars and rollback", () => {
    const { builder, registry, createPlugin } = createDiagnosticFixture();
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
    const { registry, createPlugin } = createDiagnosticFixture();
    const { record: alpha, api: alphaApi } = createPlugin("alpha");
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
    const { registry, createPlugin } = createDiagnosticFixture();
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

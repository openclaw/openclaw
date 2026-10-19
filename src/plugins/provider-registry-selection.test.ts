import { describe, expect, it } from "vitest";
import { normalizeModelRef } from "../agents/model-ref-shared.js";
import { resolveProviderEndpoint } from "../agents/provider-attribution.js";
import { loadBundledPluginFacade as loadFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { registerProviderPlugins } from "../test-utils/plugin-registration.js";
import { makeEmptyPluginMetadataOwners } from "./current-plugin-metadata.test-support.js";
import { createPluginRecord } from "./loader-records.js";
import { PluginInstance } from "./plugin-instance.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import { findProviderRuntimeRegistrationInRegistry as findProvider } from "./provider-registry-selection.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

function provider(id: string, aliases?: string[], hookAliases?: string[]): ProviderPlugin {
  return { id, label: id, auth: [], aliases, hookAliases };
}

function registryWith(providers: Record<string, ProviderPlugin>) {
  const registry = createEmptyPluginRegistry();
  registry.providers = Object.entries(providers).map(([pluginId, entry]) => ({
    pluginId,
    source: "fixture.ts",
    provider: entry,
  }));
  return registry;
}

function normalize(registry: ReturnType<typeof createEmptyPluginRegistry>, ref = "target") {
  return withPluginRuntimeRegistryScope(
    registry,
    () => normalizeModelRef(ref, "model", { allowManifestNormalization: false }).model,
  );
}

describe("provider registry selection", () => {
  const url = "https://coding-intl.dashscope.aliyuncs.com/v1";
  it.each([
    ["dashscope", undefined],
    ["custom-dashscope", url],
  ] as const)("resolves Qwen quota hooks for %s", async (providerId, baseUrl) => {
    const plugin = await loadFacade<{
      default: Parameters<typeof registerProviderPlugins>[0];
    }>({ pluginId: "qwen", artifactBasename: "index.js" });
    const providers = await registerProviderPlugins(plugin.default);
    const owners = makeEmptyPluginMetadataOwners();
    owners.providerEndpoints = [{ endpointClass: "modelstudio-native", baseUrls: [url] }];
    const selected = findProvider({
      registry: {
        providers: providers.map((entry) => ({
          pluginId: "qwen",
          source: "fixture.ts",
          provider: entry,
        })),
      },
      provider: providerId,
      ownerRefs: baseUrl ? [resolveProviderEndpoint(baseUrl, owners).endpointClass] : [],
    })?.provider;

    expect(selected?.id).toBe("qwen");
    expect(
      selected?.classifyFailoverReason?.({
        provider: providerId,
        status: 429,
        code: "insufficient_quota",
        errorMessage: "Free allocated quota exceeded.",
      }),
    ).toBe("billing");
  });

  it.each([
    { ref: " TARGET ", refs: [], expected: "target" },
    { ref: "alias", refs: [], expected: "first" },
    { ref: "missing", refs: [], expected: undefined },
    { ref: "alias", refs: ["last"], expected: "last" },
    { ref: "target", refs: ["first"], expected: "target" },
    { ref: "missing", refs: ["last", "hook"], expected: "first" },
    { ref: "missing", refs: [" hook ", "hook"], expected: "first" },
  ])("selects $ref with owner refs $refs", ({ ref, refs, expected }) => {
    const registry = registryWith({
      first: provider("first", ["target", "alias"], ["hook"]),
      target: provider("target"),
      last: provider("last"),
    });
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(findProvider({ registry, provider: ref, ownerRefs: refs })?.provider.id).toBe(
        expected,
      );
    }
  });

  it("rechecks owner eligibility and preserves registry order for colliding ids and aliases", () => {
    const registry = registryWith({
      "alias-owner": provider("alias", ["target"]),
      "first-owner": provider("TARGET"),
      "second-owner": provider("target"),
    });
    const allowed = new Set(["alias-owner", "first-owner", "second-owner"]);
    const lookup = () =>
      findProvider({
        registry,
        provider: "target",
        ownerRefs: [],
        isOwnerEligible: (id) => allowed.has(id),
      })?.pluginId;
    expect(lookup()).toBe("first-owner");
    allowed.delete("first-owner");
    expect(lookup()).toBe("second-owner");
    allowed.delete("second-owner");
    expect(lookup()).toBe("alias-owner");
    allowed.clear();
    expect(lookup()).toBeUndefined();
  });

  it("refreshes after registration, rollback, contribution copying, and generation replacement", () => {
    const source = createTestPluginRegistry();
    const target = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "owner",
      source: "fixture.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const lookup = (registry = source.registry) =>
      findProvider({ registry, provider: "hook", ownerRefs: [] })?.provider.label;
    expect(lookup()).toBeUndefined();
    expect(lookup(target.registry)).toBeUndefined();
    source.registerProvider(record, provider("first", [], ["hook"]));
    expect(lookup()).toBe("first");
    projectPluginContributions(source.registry, record, target.registry);
    expect(lookup(target.registry)).toBe("first");
    source.rollbackPluginGlobalSideEffects(record.id, record);
    expect(lookup()).toBeUndefined();
    source.registerProvider(record, provider("second", [], ["hook"]));
    expect(lookup()).toBe("second");
    expect(lookup(target.registry)).toBe("first");
    expect(lookup(createEmptyPluginRegistry())).toBeUndefined();
  });

  it("does not reread unrelated provider metadata during warm model normalization", () => {
    const reads = { id: 0, env: 0, label: 0 };
    const selectedProvider: ProviderPlugin = {
      ...provider("target", ["alias"]),
      pluginId: "provider-supplied-owner",
      get label() {
        expect(this).toBe(selectedProvider);
        reads.label++;
        return "Target";
      },
      get envVars() {
        reads.env++;
        return ["FIXTURE_API_KEY"];
      },
      normalizeModelId({ modelId }) {
        const label = this.label;
        expect(this.label).toBe(label);
        this.label = "local change";
        expect(this.label).toBe("local change");
        return `${this.pluginId}-${this.id}-${label}-${modelId}`;
      },
    };
    const registry = registryWith({
      unrelated: {
        ...provider("unrelated"),
        get id() {
          reads.id++;
          return "unrelated";
        },
      },
      owner: selectedProvider,
    });
    withPluginRuntimeRegistryScope(registry, () => {
      const normalizeRef = (ref: string) =>
        normalizeModelRef(ref, "model", { allowManifestNormalization: false }).model;
      expect(normalizeRef("target")).toBe("owner-target-Target-model");
      expect(reads.env).toBe(0);
      reads.id = 0;
      for (const ref of ["target", "alias", "missing"]) {
        expect(normalizeRef(ref)).toBe(ref === "missing" ? "model" : "owner-target-Target-model");
      }
      expect(reads).toEqual({ id: 0, env: 0, label: 3 });
    });
  });

  it.each([false, true])("keeps normalizer ownership (managed=%s)", async (managed) => {
    const instance = managed ? new PluginInstance("owner") : undefined;
    const source: ProviderPlugin = {
      id: "target",
      label: "Target",
      auth: [],
      envVars: ["SOURCE_KEY"],
      normalizeModelId({ modelId }) {
        if (managed) {
          expect(this).toBe(source);
          return `managed-${modelId}`;
        }
        expect("label" in this).toBe(true);
        expect(Object.hasOwn(this, "auth")).toBe(true);
        delete this.envVars;
        expect(this.envVars).toBeUndefined();
        expect("envVars" in this).toBe(false);
        expect(Object.hasOwn(this, "envVars")).toBe(false);
        expect(Object.keys(this)).toEqual(["id", "label", "auth", "normalizeModelId", "pluginId"]);
        this.label = "Local";
        return `${this.pluginId}-${this.label}-${modelId}`;
      },
    };
    const registry = registryWith({ owner: instance ? instance.wrap(source) : source });
    try {
      expect(normalize(registry)).toBe(managed ? "managed-model" : "owner-Local-model");
      if (instance) {
        await instance.dispose();
        expect(() => normalize(registry)).toThrow("reloaded or disabled");
      } else {
        expect(source).toMatchObject({ label: "Target", envVars: ["SOURCE_KEY"] });
      }
    } finally {
      await instance?.dispose();
    }
  });
});

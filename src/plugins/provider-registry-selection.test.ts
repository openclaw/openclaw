import { describe, expect, it } from "vitest";
import { normalizeModelRef } from "../agents/model-ref-shared.js";
import { resolveProviderEndpoint } from "../agents/provider-attribution.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { registerProviderPlugin } from "../test-utils/plugin-registration.js";
import { makeEmptyPluginMetadataOwners } from "./current-plugin-metadata.test-support.js";
import { createPluginRecord } from "./loader-records.js";
import { PluginInstance } from "./plugin-instance.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import { findProviderRuntimeRegistrationInRegistry } from "./provider-registry-selection.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

function provider(id: string, aliases?: string[], hookAliases?: string[]): ProviderPlugin {
  return { id, label: id, auth: [], aliases, hookAliases };
}

function registration(entry: ProviderPlugin, pluginId = entry.id) {
  return { pluginId, source: "fixture.ts", provider: entry };
}

function registryWith(...providers: ReturnType<typeof registration>[]) {
  const registry = createEmptyPluginRegistry();
  registry.providers.push(...providers);
  return registry;
}

function normalize(registry: ReturnType<typeof createEmptyPluginRegistry>, ref = "target") {
  return withPluginRuntimeRegistryScope(
    registry,
    () => normalizeModelRef(ref, "model", { allowManifestNormalization: false }).model,
  );
}

describe("provider registry selection", () => {
  it.each([
    ["dashscope", undefined],
    ["custom-dashscope", "https://coding-intl.dashscope.aliyuncs.com/v1"],
  ] as const)("resolves Qwen quota hooks for %s", async (providerId, baseUrl) => {
    const plugin = await loadBundledPluginFacade<{
      default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
    }>({ pluginId: "qwen", artifactBasename: "index.js" });
    const { providers } = await registerProviderPlugin({
      plugin: plugin.default,
      id: "qwen",
      name: "Qwen Provider",
    });
    const owners = makeEmptyPluginMetadataOwners();
    owners.providerEndpoints = [
      {
        endpointClass: "modelstudio-native",
        baseUrls: ["https://coding-intl.dashscope.aliyuncs.com/v1"],
      },
    ];
    const selected = findProviderRuntimeRegistrationInRegistry({
      registry: { providers: providers.map((entry) => registration(entry, "qwen")) },
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
    const registry = registryWith(
      ...[
        provider("first", ["target", "alias"], ["hook"]),
        provider("target"),
        provider("last"),
      ].map((entry) => registration(entry)),
    );
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(
        findProviderRuntimeRegistrationInRegistry({ registry, provider: ref, ownerRefs: refs })
          ?.provider.id,
      ).toBe(expected);
    }
  });

  it("rechecks owner eligibility and preserves registry order for colliding ids and aliases", () => {
    const registry = registryWith(
      registration(provider("alias", ["target"]), "alias-owner"),
      registration(provider("TARGET"), "first-owner"),
      registration(provider("target"), "second-owner"),
    );
    const allowed = new Set(["alias-owner", "first-owner", "second-owner"]);
    const lookup = () =>
      findProviderRuntimeRegistrationInRegistry({
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
      findProviderRuntimeRegistrationInRegistry({
        registry,
        provider: "hook",
        ownerRefs: [],
      })?.provider.label;
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
    let unrelatedReads = 0;
    let selectedMetadataReads = 0;
    let labelReads = 0;
    const selectedProvider: ProviderPlugin = {
      ...provider("target", ["alias"]),
      pluginId: "provider-supplied-owner",
      get label() {
        expect(this).toBe(selectedProvider);
        labelReads++;
        return "Target";
      },
      get envVars() {
        selectedMetadataReads++;
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
    const registry = registryWith(
      registration(
        {
          ...provider("unrelated"),
          get id() {
            unrelatedReads++;
            return "unrelated";
          },
        },
        "unrelated",
      ),
      registration(selectedProvider, "owner"),
    );
    withPluginRuntimeRegistryScope(registry, () => {
      const normalizeRef = (ref: string) =>
        normalizeModelRef(ref, "model", { allowManifestNormalization: false }).model;
      expect(normalizeRef("target")).toBe("owner-target-Target-model");
      expect(selectedMetadataReads).toBe(0);
      unrelatedReads = 0;
      for (const ref of ["target", "alias", "missing"]) {
        expect(normalizeRef(ref)).toBe(ref === "missing" ? "model" : "owner-target-Target-model");
      }
      expect(unrelatedReads).toBe(0);
      expect(selectedMetadataReads).toBe(0);
      expect(labelReads).toBe(3);
    });
  });

  it("retains the managed normalizer receiver and refuses calls after revocation", async () => {
    const instance = new PluginInstance("owner");
    const managedProvider: ProviderPlugin = {
      ...provider("target"),
      normalizeModelId({ modelId }) {
        expect(this).toBe(managedProvider);
        return `managed-${modelId}`;
      },
    };
    const registry = registryWith(registration(instance.wrap(managedProvider), "owner"));
    try {
      expect(normalize(registry)).toBe("managed-model");
      await instance.dispose();
      expect(() => normalize(registry)).toThrow("reloaded or disabled");
    } finally {
      await instance.dispose();
    }
  });

  it("keeps plain normalizer reflection and deletion on its isolated receiver", () => {
    const source: ProviderPlugin = {
      id: "target",
      label: "Target",
      auth: [],
      envVars: ["SOURCE_KEY"],
      normalizeModelId({ modelId }) {
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
    expect(normalize(registryWith(registration(source, "owner")))).toBe("owner-Local-model");
    expect(source.label).toBe("Target");
    expect(source.envVars).toEqual(["SOURCE_KEY"]);
  });
});

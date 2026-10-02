import { describe, expect, it } from "vitest";
import { normalizeModelRef } from "../agents/model-ref-shared.js";
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

describe("provider registry selection", () => {
  it.each([
    { ref: "target", refs: [], expected: "target" },
    { ref: " TARGET ", refs: [], expected: "target" },
    { ref: "alias", refs: [], expected: "first" },
    { ref: "hook", refs: [], expected: "first" },
    { ref: "missing", refs: [], expected: undefined },
    { ref: " ", refs: [], expected: undefined },
    { ref: "alias", refs: ["last"], expected: "last" },
    { ref: "target", refs: ["first"], expected: "target" },
    { ref: "missing", refs: ["last", "hook"], expected: "first" },
    { ref: "missing", refs: [" hook ", "hook"], expected: "first" },
  ])("selects $ref with owner refs $refs", ({ ref, refs, expected }) => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push(
      ...[
        provider("first", ["target", "alias"], ["hook"]),
        provider("target"),
        provider("last"),
      ].map((entry) => ({ pluginId: entry.id, source: "fixture.ts", provider: entry })),
    );
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(
        findProviderRuntimeRegistrationInRegistry({ registry, provider: ref, ownerRefs: refs })
          ?.provider.id,
      ).toBe(expected);
    }
  });

  it("rechecks owner eligibility and preserves registry order for colliding ids and aliases", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push(
      { pluginId: "alias-owner", source: "fixture.ts", provider: provider("alias", ["target"]) },
      { pluginId: "first-owner", source: "fixture.ts", provider: provider("TARGET") },
      { pluginId: "second-owner", source: "fixture.ts", provider: provider("target") },
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
    const registry = createEmptyPluginRegistry();
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
    registry.providers.push(
      {
        pluginId: "unrelated",
        source: "fixture.ts",
        provider: {
          ...provider("unrelated"),
          get id() {
            unrelatedReads++;
            return "unrelated";
          },
        },
      },
      {
        pluginId: "owner",
        source: "fixture.ts",
        provider: selectedProvider,
      },
    );
    withPluginRuntimeRegistryScope(registry, () => {
      const normalize = (ref: string) =>
        normalizeModelRef(ref, "model", { allowManifestNormalization: false }).model;
      expect(normalize("target")).toBe("owner-target-Target-model");
      expect(selectedMetadataReads).toBe(0);
      unrelatedReads = 0;
      for (const ref of ["target", "alias", "missing"]) {
        expect(normalize(ref)).toBe(ref === "missing" ? "model" : "owner-target-Target-model");
      }
      expect(unrelatedReads).toBe(0);
      expect(selectedMetadataReads).toBe(0);
      expect(labelReads).toBe(3);
    });
  });

  it("retains the managed normalizer receiver and refuses calls after revocation", async () => {
    const registry = createEmptyPluginRegistry();
    const instance = new PluginInstance("owner");
    const managedProvider: ProviderPlugin = {
      ...provider("target"),
      normalizeModelId({ modelId }) {
        expect(this).toBe(managedProvider);
        return `managed-${modelId}`;
      },
    };
    registry.providers.push({
      pluginId: "owner",
      source: "fixture.ts",
      provider: instance.wrap(managedProvider),
    });
    const normalize = () =>
      withPluginRuntimeRegistryScope(
        registry,
        () => normalizeModelRef("target", "model", { allowManifestNormalization: false }).model,
      );
    try {
      expect(normalize()).toBe("managed-model");
      await instance.dispose();
      expect(normalize).toThrow("reloaded or disabled");
    } finally {
      await instance.dispose();
    }
  });

  it("keeps plain normalizer reflection and deletion on its isolated receiver", () => {
    const registry = createEmptyPluginRegistry();
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
    registry.providers.push({ pluginId: "owner", source: "fixture.ts", provider: source });
    expect(
      withPluginRuntimeRegistryScope(
        registry,
        () => normalizeModelRef("target", "model", { allowManifestNormalization: false }).model,
      ),
    ).toBe("owner-Local-model");
    expect(source.label).toBe("Target");
    expect(source.envVars).toEqual(["SOURCE_KEY"]);
  });
});

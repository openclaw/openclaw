import { describe, expect, it } from "vitest";
import { normalizeProviderModelIdWithRuntime } from "../agents/provider-model-normalization.runtime.js";
import { createPluginRecord } from "./loader-records.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import { findProviderRuntimePluginInRegistry } from "./provider-registry-selection.js";
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
        findProviderRuntimePluginInRegistry({ registry, provider: ref, ownerRefs: refs })?.id,
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
      findProviderRuntimePluginInRegistry({
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
      findProviderRuntimePluginInRegistry({
        registry,
        provider: "hook",
        ownerRefs: [],
      })?.label;
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
    const registry = createEmptyPluginRegistry();
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
        provider: {
          ...provider("target", ["alias"]),
          normalizeModelId() {
            return `${this.pluginId}-model`;
          },
        },
      },
    );
    withPluginRuntimeRegistryScope(registry, () => {
      const normalize = (ref: string) =>
        normalizeProviderModelIdWithRuntime({
          provider: ref,
          context: { provider: ref, modelId: "model" },
        });
      expect(normalize("target")).toBe("owner-model");
      unrelatedReads = 0;
      for (const ref of ["target", "alias", "missing"]) {
        expect(normalize(ref)).toBe(ref === "missing" ? undefined : "owner-model");
      }
      expect(unrelatedReads).toBe(0);
    });
  });
});

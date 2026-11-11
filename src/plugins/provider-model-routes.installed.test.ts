import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { configForProviders } from "../agents/model-auth.fixtures.test-support.js";
import { createConfiguredModelCatalogOverridesResolver } from "../agents/model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { getModelRefStatus, resolveModelRefFromString } from "../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { materializePreparedModelCatalog } from "../agents/prepared-model-runtime.full-catalog.js";
import type { PreparedRuntimeCapabilityModel } from "../agents/prepared-model-runtime.types.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { loadPluginManifest } from "./manifest.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createProviderModelCatalogIdNormalizer } from "./provider-model-routes.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const logical = { provider: "arcee", model: "trinity-large-thinking" };
const wire = { provider: "arcee", model: "arcee-ai/trinity-large-thinking" };
const modelPolicy = (allow: string[]): OpenClawConfig => ({
  agents: { defaults: { modelPolicy: { allow } } },
});

describe("installed Arcee catalog identity", () => {
  function installed(
    trustedOfficialInstall: boolean,
    run: (snapshot: PluginMetadataSnapshot) => void,
  ) {
    const root = temporary.make("arcee-installed-policy-");
    const bundled = path.join(root, "bundled");
    const pluginRoot = path.join(root, "installed", "arcee");
    fs.mkdirSync(bundled);
    fs.mkdirSync(pluginRoot, { recursive: true });
    for (const file of ["provider-policy-api.ts", "package.json", "openclaw.plugin.json"]) {
      fs.copyFileSync(
        path.join(process.cwd(), "extensions", "arcee", file),
        path.join(pluginRoot, file),
      );
    }
    const loaded = loadPluginManifest(pluginRoot);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "arcee",
          origin: "global",
          rootDir: pluginRoot,
          providers: ["arcee"],
          providerAuthAliases: loaded.manifest.providerAuthAliases,
          trustedOfficialInstall,
        },
      ],
    });
    withEnv(
      { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1" },
      () => withPluginMetadataSnapshotScope(snapshot, () => run(snapshot)),
    );
  }

  function installedTest(name: string, run: (snapshot: PluginMetadataSnapshot) => void) {
    it(name, () => installed(true, run));
  }

  installedTest("keeps exact grants distinct from catalog identity", (metadataSnapshot) => {
    expect(createProviderModelCatalogIdNormalizer("arcee")(wire.model)).toBe(logical.model);
    for (const ref of [logical, wire]) {
      expect(
        resolveModelRefFromString({
          cfg: {},
          raw: `${ref.provider}/${ref.model}`,
          defaultProvider: "arcee",
          manifestPlugins: metadataSnapshot,
          allowManifestNormalization: true,
          allowPluginNormalization: false,
        })?.ref,
      ).toEqual(ref);
    }

    for (const { allow, expected } of [
      { allow: `arcee/${logical.model}`, expected: [true, false] },
      { allow: `arcee/${wire.model}`, expected: [false, true] },
      { allow: "arcee/*", expected: [true, true] },
    ]) {
      const params = {
        cfg: modelPolicy([allow]),
        catalog: [logical, wire].map(({ provider, model }) => catalogEntry(provider, model)),
        defaultProvider: "arcee",
        manifestPlugins: metadataSnapshot,
        allowManifestNormalization: true,
        allowPluginNormalization: false,
      };
      const policy = createModelVisibilityPolicy(params);
      expect.soft([policy.allows(logical), policy.allows(wire)], allow).toEqual(expected);
      const status = [logical, wire].map((ref) => getModelRefStatus({ ...params, ref }).allowed);
      expect.soft(status, allow).toEqual(expected);
    }
  });

  it.each([false, true])(
    "only selects an authorized Arcee fallback (later row: %s)",
    (laterRow) => {
      installed(true, (manifestPlugins) => {
        const wireRow = catalogEntry("arcee", wire.model);
        const later = catalogEntry("arcee", "safe-model");
        const policy = createModelVisibilityPolicy({
          cfg: modelPolicy([`arcee/${logical.model}`, ...(laterRow ? ["arcee/safe-model"] : [])]),
          catalog: laterRow ? [wireRow, later] : [wireRow],
          defaultProvider: "arcee",
          manifestPlugins,
        });

        expect(policy.allowedCatalog[0]).toEqual(wireRow);
        expect(policy.resolveSelection(logical)).toEqual(logical);
        expect(policy.resolveSelection({ provider: "arcee", model: "denied-model" })).toEqual(
          laterRow ? { provider: "arcee", model: "safe-model" } : null,
        );
      });
    },
  );

  installedTest("keeps captured grants stable across catalog policy changes", () => {
    const empty = createPluginMetadataSnapshotFixture();
    const captured = withPluginMetadataSnapshotScope(empty, () => {
      expect(createProviderModelCatalogIdNormalizer("arcee")(wire.model)).toBe(wire.model);
      return [
        { allowed: logical, denied: wire },
        { allowed: wire, denied: logical },
      ].map(({ allowed, denied }) => {
        const policy = createModelVisibilityPolicy({
          cfg: modelPolicy([`arcee/${allowed.model}`]),
          catalog: [],
          defaultProvider: "arcee",
          manifestPlugins: empty,
          allowManifestNormalization: true,
          allowPluginNormalization: false,
        });
        expect(policy.allows(allowed)).toBe(true);
        expect(policy.allows(denied)).toBe(false);
        return { policy, allowed, denied };
      });
    });

    expect(createProviderModelCatalogIdNormalizer("arcee")(wire.model)).toBe(logical.model);
    for (const { policy, allowed, denied } of captured) {
      expect.soft(policy.allows(allowed)).toBe(true);
      expect.soft(policy.allows(denied)).toBe(false);
    }
  });

  it("does not load an untrusted installed owner's identity hook", () => {
    installed(false, () => {
      expect(createProviderModelCatalogIdNormalizer("arcee")(wire.model)).toBe(wire.model);
    });
  });
  installedTest("honors explicit and captured owners over ambient metadata", () => {
    const empty = createPluginMetadataSnapshotFixture();
    expect(createProviderModelCatalogIdNormalizer("arcee", empty)(wire.model)).toBe(wire.model);
    const normalize = createProviderModelCatalogIdNormalizer("arcee");
    withPluginMetadataSnapshotScope(empty, () => {
      expect(normalize(wire.model)).toBe(logical.model);
    });
  });

  function catalogEntry(provider: string, id: string): ModelCatalogEntry {
    return { provider, id, name: id, reasoning: false };
  }

  function runtimeCapability(provider: string, modelId: string): PreparedRuntimeCapabilityModel {
    return {
      provider,
      modelId,
      model: makeProviderModelFixture({
        provider: "fixture-runtime",
        id: modelId,
        api: "openai-completions",
        baseUrl: "https://fixture.example.test/v1",
        reasoning: true,
        params: { runtimeModel: modelId },
      }),
    };
  }

  installedTest("materializes identities with the invocation's policy", (metadataSnapshot) => {
    const canonical = catalogEntry("arcee", logical.model);
    const variant = catalogEntry("arcee", `${wire.model}@personal`);
    const distinct = [
      catalogEntry("fixture-none", "Reader"),
      catalogEntry("fixture-none", "reader"),
      catalogEntry("fixture-none", "Reader@variant"),
      catalogEntry("fixture/a", "b"),
      catalogEntry("fixture", "a/b"),
    ];
    const catalog: ModelCatalogSnapshot = {
      entries: [canonical, ...distinct],
      routeVariants: [variant],
      staticEntries: [canonical, ...distinct],
    };
    const configured = {
      ...catalogEntry("arcee", `${wire.model}@work`),
      name: "Configured",
    };
    const runtimes = [
      runtimeCapability(" Arcee ", `${wire.model}@work`),
      runtimeCapability("fixture-none", "Reader"),
      runtimeCapability("fixture/a", "b"),
    ];
    const materialize = (metadata: PluginMetadataSnapshot) =>
      withPluginMetadataSnapshotScope(metadata, () =>
        materializePreparedModelCatalog(catalog, runtimes, [configured]),
      );
    const empty = createPluginMetadataSnapshotFixture();
    const before = materialize(empty);
    expect(before.entries[0]).toBe(canonical);
    expect(before.routeVariants[0]).toBe(variant);
    expect(before.staticEntries).toHaveLength(7);

    const prepared = materialize(metadataSnapshot);
    expect(prepared.entries.map(({ id, reasoning }) => [id, reasoning])).toEqual([
      ["trinity-large-thinking", true],
      ["Reader", true],
      ["reader", false],
      ["Reader@variant", false],
      ["b", true],
      ["a/b", false],
    ]);
    expect(prepared.routeVariants[0]).toMatchObject({
      id: "arcee-ai/trinity-large-thinking@personal",
      reasoning: true,
      thinkingPolicyProvider: "fixture-runtime",
    });
    expect(prepared.staticEntries).toHaveLength(6);
    expect(prepared.staticEntries?.[0]).toMatchObject({
      id: "arcee-ai/trinity-large-thinking@work",
      name: "Configured",
      reasoning: true,
    });
    expect(materialize(empty)).toEqual(before);
  });

  installedTest("captures rows before capabilities, then rereads identities", () => {
    let prepared = false;
    const shared = catalogEntry("fixture-none", "Before");
    const catalog: ModelCatalogSnapshot = {
      get entries() {
        return prepared ? [catalogEntry("fixture-none", "Decoy")] : [shared];
      },
      get routeVariants() {
        if (prepared) {
          shared.id = "After";
        }
        return [shared];
      },
    };
    const before = runtimeCapability("fixture-none", "Before");
    const first: PreparedRuntimeCapabilityModel = {
      provider: before.provider,
      modelId: before.modelId,
      get model() {
        prepared = true;
        return before.model;
      },
    };

    const result = materializePreparedModelCatalog(catalog, [
      first,
      runtimeCapability("fixture-none", "After"),
    ]);

    expect(result.entries[0]).toMatchObject({
      id: "Before",
      params: { runtimeModel: "Before" },
    });
    expect(result.routeVariants[0]).toMatchObject({
      id: "After",
      params: { runtimeModel: "After" },
    });
  });

  installedTest("resolves installed authored metadata and endpoint auth", (metadataSnapshot) => {
    const cfg: OpenClawConfig = configForProviders({
      arcee: {
        api: "openai-completions",
        baseUrl: "https://api.arcee.ai/api/v1",
        models: [
          {
            id: wire.model,
            name: "Authored route",
            baseUrl: "https://openrouter.ai/api/v1",
            reasoning: true,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    });
    expect(
      createConfiguredModelCatalogOverridesResolver({ cfg })({
        provider: "arcee",
        id: logical.model,
      }),
    ).toMatchObject({ name: "Authored route", contextWindow: 32768 });
    const projected = resolveModelProviderAuthConfig({
      config: cfg,
      provider: "arcee",
      modelId: logical.model,
      metadataSnapshot,
    });
    expect(projected.models?.providers?.arcee?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.models?.providers?.arcee?.baseUrl).toBe("https://api.arcee.ai/api/v1");
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { createConfiguredModelCatalogOverridesResolver } from "../agents/model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { getModelRefStatus, resolveModelRefFromString } from "../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { materializePreparedModelCatalog } from "../agents/prepared-model-runtime.full-catalog.js";
import type { PreparedRuntimeCapabilityModel } from "../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { loadPluginManifest } from "./manifest.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createProviderModelCatalogIdNormalizer } from "./provider-model-routes.js";
import { resolveProviderPolicySurface } from "./provider-public-artifacts.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

describe("installed Arcee catalog identity", () => {
  function installed(
    trustedOfficialInstall: boolean,
    run: (root: string, snapshot: PluginMetadataSnapshot) => void,
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
    expect(loaded.manifest.id).toBe("arcee");
    expect(loaded.manifest.providers).toEqual(["arcee"]);
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
      () => {
        withPluginMetadataSnapshotScope(snapshot, () => run(pluginRoot, snapshot));
      },
    );
  }

  it("loads the actual Arcee policy through the existing trusted installed owner", () => {
    installed(true, (rootDir) => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "arcee",
            origin: "global",
            rootDir,
            providers: ["arcee"],
            trustedOfficialInstall: true,
          },
        ],
      });
      const surface = resolveProviderPolicySurface("arcee", {
        manifestRegistry: snapshot.manifestRegistry,
      });
      expect(
        surface?.normalizeModelCatalogId?.({
          provider: "arcee",
          modelId: "arcee-ai/trinity-large-thinking",
        }),
      ).toBe("trinity-large-thinking");
    });
  });

  it("uses that installed owner for authored-row identity", () => {
    installed(true, () => {
      expect(
        createProviderModelCatalogIdNormalizer("arcee")("arcee-ai/trinity-large-thinking"),
      ).toBe("trinity-large-thinking");
    });
  });

  it("keeps catalog-equivalent Arcee ids distinct in exact model policy", () => {
    installed(true, (_root, metadataSnapshot) => {
      const logical = { provider: "arcee", model: "trinity-large-thinking" };
      const wire = { provider: "arcee", model: "arcee-ai/trinity-large-thinking" };
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
          cfg: { agents: { defaults: { modelPolicy: { allow: [allow] } } } },
          catalog: [logical, wire].map(({ provider, model }) => ({
            provider,
            id: model,
            name: model,
          })),
          defaultProvider: "arcee",
          manifestPlugins: metadataSnapshot,
          allowManifestNormalization: true,
          allowPluginNormalization: false,
        };
        const policy = createModelVisibilityPolicy(params);
        expect.soft([policy.allows(logical), policy.allows(wire)], allow).toEqual(expected);
        expect
          .soft(
            [logical, wire].map((ref) => getModelRefStatus({ ...params, ref }).allowed),
            allow,
          )
          .toEqual(expected);
      }
    });
  });

  it.each([false, true])(
    "only selects an authorized Arcee fallback (later row: %s)",
    (laterRow) => {
      installed(true, (_root, manifestPlugins) => {
        const logical = { provider: "arcee", model: "trinity-large-thinking" };
        const wire = { provider: "arcee", id: "arcee-ai/trinity-large-thinking", name: "Wire" };
        const later = { provider: "arcee", id: "safe-model", name: "Allowed fallback" };
        const policy = createModelVisibilityPolicy({
          cfg: {
            agents: {
              defaults: {
                modelPolicy: {
                  allow: laterRow
                    ? ["arcee/trinity-large-thinking", "arcee/safe-model"]
                    : ["arcee/trinity-large-thinking"],
                },
              },
            },
          },
          catalog: laterRow ? [wire, later] : [wire],
          defaultProvider: "arcee",
          manifestPlugins,
        });

        expect(policy.allowedCatalog[0]).toEqual(wire);
        expect(policy.resolveSelection(logical)).toEqual(logical);
        expect(policy.resolveSelection({ provider: "arcee", model: "denied-model" })).toEqual(
          laterRow ? { provider: "arcee", model: "safe-model" } : null,
        );
      });
    },
  );

  it("keeps captured exact grants stable when the current catalog policy changes", () => {
    installed(true, () => {
      const logical = { provider: "arcee", model: "trinity-large-thinking" };
      const wire = { provider: "arcee", model: "arcee-ai/trinity-large-thinking" };
      const empty = createPluginMetadataSnapshotFixture();
      const captured = withPluginMetadataSnapshotScope(empty, () => {
        expect(createProviderModelCatalogIdNormalizer("arcee")(wire.model)).toBe(wire.model);
        return [
          { allowed: logical, denied: wire },
          { allowed: wire, denied: logical },
        ].map(({ allowed, denied }) => {
          const policy = createModelVisibilityPolicy({
            cfg: {
              agents: { defaults: { modelPolicy: { allow: [`arcee/${allowed.model}`] } } },
            },
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
  });

  it("does not load an untrusted installed owner's identity hook", () => {
    installed(false, () => {
      expect(
        createProviderModelCatalogIdNormalizer("arcee")("arcee-ai/trinity-large-thinking"),
      ).toBe("arcee-ai/trinity-large-thinking");
    });
  });
  it("honors an explicitly empty metadata owner over the ambient installed owner", () => {
    installed(true, () => {
      const empty = createPluginMetadataSnapshotFixture();
      expect(
        createProviderModelCatalogIdNormalizer("arcee", empty)("arcee-ai/trinity-large-thinking"),
      ).toBe("arcee-ai/trinity-large-thinking");
    });
  });

  it("keeps a captured normalizer bound to its prepared owner", () => {
    installed(true, () => {
      const normalize = createProviderModelCatalogIdNormalizer("arcee");
      withPluginMetadataSnapshotScope(createPluginMetadataSnapshotFixture(), () => {
        expect(normalize("arcee-ai/trinity-large-thinking")).toBe("trinity-large-thinking");
      });
    });
  });

  function catalogEntry(provider: string, id: string): ModelCatalogEntry {
    return { provider, id, name: id, reasoning: false };
  }

  function runtimeCapability(provider: string, modelId: string): PreparedRuntimeCapabilityModel {
    return {
      provider,
      modelId,
      model: {
        provider: "fixture-runtime",
        id: modelId,
        name: modelId,
        api: "openai-completions",
        baseUrl: "https://fixture.example.test/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 256,
        params: { runtimeModel: modelId },
      },
    };
  }

  it("materializes catalog identities with the policy selected for each invocation", () => {
    installed(true, (_root, metadataSnapshot) => {
      const canonical = catalogEntry("arcee", "trinity-large-thinking");
      const variant = catalogEntry("arcee", "arcee-ai/trinity-large-thinking@personal");
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
        ...catalogEntry("arcee", "arcee-ai/trinity-large-thinking@work"),
        name: "Configured",
      };
      const runtimes = [
        runtimeCapability(" Arcee ", "arcee-ai/trinity-large-thinking@work"),
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
  });

  it("captures catalog rows before capabilities and rereads changed row identities", () => {
    installed(true, () => {
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
  });

  it("uses installed identity for authored catalog and endpoint auth", () => {
    installed(true, (_root, metadataSnapshot) => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            arcee: {
              api: "openai-completions",
              baseUrl: "https://api.arcee.ai/api/v1",
              models: [
                {
                  id: "arcee-ai/trinity-large-thinking",
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
          },
        },
      };
      expect(
        createConfiguredModelCatalogOverridesResolver({ cfg })({
          provider: "arcee",
          id: "trinity-large-thinking",
        }),
      ).toMatchObject({ name: "Authored route", contextWindow: 32768 });
      const projected = resolveModelProviderAuthConfig({
        config: cfg,
        provider: "arcee",
        modelId: "trinity-large-thinking",
        metadataSnapshot,
      });
      expect(projected.models?.providers?.arcee?.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(cfg.models?.providers?.arcee?.baseUrl).toBe("https://api.arcee.ai/api/v1");
    });
  });
});

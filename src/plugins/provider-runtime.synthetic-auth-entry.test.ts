import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  captureProviderSyntheticAuthFacts,
  resolveProviderSyntheticAuthWithPlugin,
} from "./provider-runtime.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeEntry(root: string, id: string, body: string) {
  const rootDir = path.join(root, id);
  fs.mkdirSync(rootDir);
  const source = path.join(rootDir, "discovery.cjs");
  fs.writeFileSync(source, body);
  return { id, rootDir, source, providerDiscoverySource: source, providers: [id] };
}

describe("synthetic auth discovery entries", () => {
  it.each(["auth-only", "manifest-catalog", "discovery-catalog"] as const)(
    "keeps an auth-only owner available beside broken discovery with %s",
    async (shape) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-entry-")));
      roots.push(root);
      const owner = writeEntry(
        root,
        "native-auth",
        `let calls = 0;
const provider = {
  id: "native-auth", label: "Native auth", auth: [],
  prepareSyntheticAuth: async () => ({
    apiKey: "fixture-" + ++calls, source: "fixture native auth", mode: "oauth"
  })
};
module.exports = ${
          shape === "discovery-catalog"
            ? '[{id: "native-auth", label: "Catalog only", auth: [], staticCatalog: {run() {}}}, provider]'
            : "provider"
        };`,
      );
      const unrelated = writeEntry(
        root,
        "unrelated",
        'throw new Error("Unrelated discovery must stay lazy");',
      );
      await using cache = createPluginCache();
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            ...owner,
            ...(shape === "manifest-catalog"
              ? {
                  modelCatalog: {
                    providers: {
                      "native-auth": {
                        baseUrl: "https://provider.example.test/v1",
                        api: "openai-completions",
                        models: [
                          {
                            id: "fixture-model",
                            name: "Fixture model",
                            reasoning: false,
                            input: ["text"],
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            contextWindow: 4096,
                            maxTokens: 1024,
                          },
                        ],
                      },
                    },
                  },
                }
              : {}),
          },
          unrelated,
        ],
      });
      bindPluginMetadataSnapshotCache(snapshot, cache);
      await withPluginCache(cache, () =>
        withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, async () => {
          const config = {};
          const env = {};
          const capture = () =>
            captureProviderSyntheticAuthFacts({ config, env, providerRefs: [owner.id] });
          for (const call of [1, 2]) {
            expect(await capture()).toEqual([
              {
                providerRef: owner.id,
                result: { apiKey: `fixture-${call}`, source: "fixture native auth", mode: "oauth" },
              },
            ]);
          }
          expect(
            resolveProviderSyntheticAuthWithPlugin({
              provider: owner.id,
              config,
              env,
              context: { config, provider: owner.id },
            }),
          ).toBeUndefined();
        }),
      );
    },
  );

  it("does not evaluate unrelated entries when the declared owner has no synthetic auth", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-entry-")));
    roots.push(root);
    const marker = path.join(root, "unrelated-loaded");
    const owner = writeEntry(
      root,
      "configured-provider",
      'module.exports = { id: "configured-provider", label: "Configured provider", auth: [] };',
    );
    const unrelated = writeEntry(
      root,
      "unrelated",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");
throw new Error("Unrelated discovery must stay lazy");`,
    );
    await using cache = createPluginCache();
    const snapshot = createPluginMetadataSnapshotFixture({ plugins: [owner, unrelated] });
    bindPluginMetadataSnapshotCache(snapshot, cache);
    await withPluginCache(cache, () =>
      withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, async () => {
        expect(
          await captureProviderSyntheticAuthFacts({
            config: {},
            env: {},
            providerRefs: [owner.id],
          }),
        ).toEqual([]);
        expect(fs.existsSync(marker)).toBe(false);
      }),
    );
  });

  it("retains lightweight discovery for an alias without a declared owner", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-entry-")));
    roots.push(root);
    const owner = writeEntry(
      root,
      "local-provider",
      `const provider = {
  id: "local-provider", aliases: ["custom-local"], label: "Local provider", auth: [],
  resolveSyntheticAuth: () => ({apiKey: "fixture-local", source: "fixture", mode: "api-key"})
};
module.exports = [{...provider, resolveSyntheticAuth: undefined, staticCatalog: {run() {}}}, provider];`,
    );
    await using cache = createPluginCache();
    const snapshot = createPluginMetadataSnapshotFixture({ plugins: [owner] });
    bindPluginMetadataSnapshotCache(snapshot, cache);
    const result = withPluginCache(cache, () =>
      withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, () => {
        const config = {};
        return resolveProviderSyntheticAuthWithPlugin({
          provider: "custom-local",
          config,
          env: {},
          context: { config, provider: "custom-local" },
        });
      }),
    );
    expect(result).toEqual({ apiKey: "fixture-local", source: "fixture", mode: "api-key" });
  });
});

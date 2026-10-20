import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
let testRoot: string;
beforeEach(() => {
  testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-entry-")));
  roots.push(testRoot);
});
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

async function withEntries<T>(
  plugins: NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]>["plugins"],
  run: () => T,
) {
  await using cache = createPluginCache();
  const snapshot = createPluginMetadataSnapshotFixture({ plugins });
  bindPluginMetadataSnapshotCache(snapshot, cache);
  return await withPluginCache(cache, () =>
    withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, run),
  );
}

describe("synthetic auth discovery entries", () => {
  it.each(["manifest-catalog", "discovery-catalog"] as const)(
    "keeps an auth-only owner available beside broken discovery with %s",
    async (shape) => {
      const owner = writeEntry(
        testRoot,
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
        testRoot,
        "unrelated",
        'throw new Error("Unrelated discovery must stay lazy");',
      );
      const catalog = {
        baseUrl: "https://provider.example.test/v1",
        api: "openai-completions" as const,
        models: [
          {
            id: "fixture-model",
            name: "Fixture model",
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 1024,
          },
        ],
      };
      await withEntries(
        [
          {
            ...owner,
            modelCatalog:
              shape === "manifest-catalog" ? { providers: { "native-auth": catalog } } : undefined,
          },
          unrelated,
        ],
        async () => {
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
        },
      );
    },
  );

  it("does not evaluate unrelated entries when the declared owner has no synthetic auth", async () => {
    const marker = path.join(testRoot, "unrelated-loaded");
    const owner = writeEntry(
      testRoot,
      "configured-provider",
      'module.exports = { id: "configured-provider", label: "Configured provider", auth: [] };',
    );
    const unrelated = writeEntry(
      testRoot,
      "unrelated",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");
throw new Error("Unrelated discovery must stay lazy");`,
    );
    await withEntries([owner, unrelated], async () => {
      expect(
        await captureProviderSyntheticAuthFacts({
          config: {},
          env: {},
          providerRefs: [owner.id],
        }),
      ).toEqual([]);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  it("retains lightweight discovery for an alias without a declared owner", async () => {
    const owner = writeEntry(
      testRoot,
      "local-provider",
      `const provider = {
  id: "local-provider", aliases: ["custom-local"], label: "Local provider", auth: [],
  resolveSyntheticAuth: () => ({apiKey: "fixture-local", source: "fixture", mode: "api-key"})
};
module.exports = [{...provider, resolveSyntheticAuth: undefined, staticCatalog: {run() {}}}, provider];`,
    );
    const result = await withEntries([owner], () => {
      const config = {};
      return resolveProviderSyntheticAuthWithPlugin({
        provider: "custom-local",
        config,
        env: {},
        context: { config, provider: "custom-local" },
      });
    });
    expect(result).toEqual({ apiKey: "fixture-local", source: "fixture", mode: "api-key" });
  });
});

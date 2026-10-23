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
  captureProviderSyntheticAuthFacts as capture,
  resolveProviderSyntheticAuthWithPlugin as resolve,
} from "./provider-runtime.js";
import { PROVIDER_RUNTIME_TEST_MODEL } from "./provider-runtime.test-support.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

let testRoot: string;
beforeEach(() => {
  testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-entry-")));
});
afterEach(() => fs.rmSync(testRoot, { recursive: true, force: true }));

function writeEntry(id: string, body: string) {
  const rootDir = path.join(testRoot, id);
  fs.mkdirSync(rootDir);
  const source = path.join(rootDir, "discovery.cjs");
  fs.writeFileSync(source, body);
  return { id, rootDir, source, providerDiscoverySource: source, providers: [id] };
}

function authParams(provider: string) {
  const config = {};
  return { provider, config, env: {}, context: { config, provider } };
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
        "unrelated",
        'throw new Error("Unrelated discovery must stay lazy");',
      );
      const catalog = {
        baseUrl: "https://provider.example.test/v1",
        api: "openai-completions" as const,
        models: [{ ...PROVIDER_RUNTIME_TEST_MODEL, api: "openai-completions" as const }],
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
          const params = authParams(owner.id);
          const captureFacts = () => capture({ ...params, providerRefs: [owner.id] });
          for (const call of [1, 2]) {
            expect(await captureFacts()).toEqual([
              {
                providerRef: owner.id,
                result: { apiKey: `fixture-${call}`, source: "fixture native auth", mode: "oauth" },
              },
            ]);
          }
          expect(resolve(params)).toBeUndefined();
        },
      );
    },
  );

  it("does not evaluate unrelated entries when the declared owner has no synthetic auth", async () => {
    const marker = path.join(testRoot, "unrelated-loaded");
    const owner = writeEntry(
      "configured-provider",
      'module.exports = { id: "configured-provider", label: "Configured provider", auth: [] };',
    );
    const unrelated = writeEntry(
      "unrelated",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");
throw new Error("Unrelated discovery must stay lazy");`,
    );
    await withEntries([owner, unrelated], async () => {
      expect(await capture({ ...authParams(owner.id), providerRefs: [owner.id] })).toEqual([]);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  it("retains lightweight discovery for an alias without a declared owner", async () => {
    const owner = writeEntry(
      "local-provider",
      `const provider = {
  id: "local-provider", aliases: ["custom-local"], label: "Local provider", auth: [],
  resolveSyntheticAuth: () => ({apiKey: "fixture-local", source: "fixture", mode: "api-key"})
};
module.exports = [{...provider, resolveSyntheticAuth: undefined, staticCatalog: {run() {}}}, provider];`,
    );
    const result = await withEntries([owner], () => resolve(authParams("custom-local")));
    expect(result).toEqual({ apiKey: "fixture-local", source: "fixture", mode: "api-key" });
  });
});

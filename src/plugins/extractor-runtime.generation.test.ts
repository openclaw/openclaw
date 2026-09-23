import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { extractDocumentContent } from "../media/document-extractors.runtime.js";
import { extractReadableContent } from "../web-fetch/content-extractors.runtime.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { finalizePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
});

describe.each([
  {
    name: "web content",
    artifact: "web-content-extractor.js",
    factory: "createFixtureWebContentExtractor",
    contract: "webContentExtractors",
    extract: (config?: OpenClawConfig) =>
      extractReadableContent({
        html: "<p>fixture</p>",
        url: "https://example.test/page",
        extractMode: "text",
        config,
      }),
  },
  {
    name: "document",
    artifact: "document-extractor.js",
    factory: "createFixtureDocumentExtractor",
    contract: "documentExtractors",
    extract: (config?: OpenClawConfig) =>
      extractDocumentContent({
        buffer: Buffer.from("fixture"),
        mimeType: "application/pdf",
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 1,
        config,
      }),
  },
])("$name extraction metadata ownership", ({ artifact, factory, contract, extract }) => {
  it.each([false, true])(
    "follows nested metadata views without re-evaluating the artifact with config=%s",
    async (hasConfig) => {
      const root = tempDirs.make("openclaw-extractor-generation-");
      const bundledDir = path.join(root, "extensions");
      const pluginId = "fixture-extractor";
      const pluginDir = path.join(bundledDir, pluginId);
      const events = path.join(root, "events.txt");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "package.json"), '{"type":"commonjs"}\n');
      fs.writeFileSync(
        path.join(pluginDir, artifact),
        `const fs = require("node:fs");
const events = ${JSON.stringify(events)};
fs.appendFileSync(events, "evaluated\\n");
exports.${factory} = () => ({
  id: "fixture-extractor",
  label: "Fixture extractor",
  mimeTypes: ["application/pdf"],
  extract() {
    fs.appendFileSync(events, "extracted\\n");
    return { text: "fixture result", images: [] };
  },
});
`,
      );
      vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
      vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
      const config: OpenClawConfig | undefined = hasConfig ? {} : undefined;
      const options = { config, trustConfigIdentity: true };
      await using cache = createPluginCache();
      const { available, empty } = withPluginCache(cache, () => ({
        available: finalizePluginMetadataSnapshot(
          createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: pluginId,
                rootDir: pluginDir,
                enabledByDefault: true,
                contracts: { [contract]: [pluginId] },
              },
            ],
          }),
        ),
        empty: finalizePluginMetadataSnapshot(createPluginMetadataSnapshotFixture()),
      }));

      await withPluginMetadataSnapshotScope(
        available,
        async () => {
          await expect(extract(config)).resolves.toMatchObject({ text: "fixture result" });
          await withPluginMetadataSnapshotScope(
            empty,
            async () => {
              await expect(extract(config)).resolves.toBeNull();
            },
            options,
          );
          await expect(extract(config)).resolves.toMatchObject({ text: "fixture result" });
        },
        options,
      );
      expect(fs.readFileSync(events, "utf8")).toBe("evaluated\nextracted\nextracted\n");
    },
  );
});

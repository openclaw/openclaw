import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { extractPdfContent } from "../media/pdf-extract.js";
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

it.each([
  ["web-content", undefined],
  ["web-content", {}],
  ["document", undefined],
  ["document", {}],
] as const)("%s extraction follows nested metadata with config=%j", async (kind, config) => {
  const document = kind === "document";
  const contract = document ? "documentExtractors" : "webContentExtractors";
  const extract = () =>
    document
      ? extractPdfContent({
          buffer: Buffer.from("fixture"),
          maxPages: 1,
          maxPixels: 100,
          minTextChars: 1,
          config,
        })
      : extractReadableContent({
          html: "<p>fixture</p>",
          url: "https://example.test/page",
          extractMode: "text",
          config,
        });
  const root = tempDirs.make("openclaw-extractor-generation-");
  const bundledDir = path.join(root, "extensions");
  const pluginId = "fixture-extractor";
  const pluginDir = path.join(bundledDir, pluginId);
  const events = path.join(root, "events.txt");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), '{"type":"commonjs"}\n');
  fs.writeFileSync(
    path.join(pluginDir, `${kind}-extractor.js`),
    `const fs = require("node:fs");
const events = ${JSON.stringify(events)};
fs.appendFileSync(events, "evaluated\\n");
exports.createFixture${document ? "Document" : "WebContent"}Extractor = () => ({
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
  const options = { config, trustConfigIdentity: true };
  await using cache = createPluginCache();
  const { available, empty } = withPluginCache(cache, () => ({
    available: finalizePluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: pluginId,
            rootDir: pluginDir,
            contracts: { [contract]: [pluginId] },
          },
        ],
      }),
    ),
    empty: finalizePluginMetadataSnapshot(createPluginMetadataSnapshotFixture()),
  }));

  const inSnapshot = (snapshot: typeof available, run: () => Promise<void>) =>
    withPluginMetadataSnapshotScope(snapshot, run, options);
  await inSnapshot(available, async () => {
    await expect(extract()).resolves.toMatchObject({ text: "fixture result" });
    await inSnapshot(empty, async () => {
      if (document) {
        await expect(extract()).rejects.toThrow("PDF extraction disabled or unavailable");
      } else {
        await expect(extract()).resolves.toBeNull();
      }
    });
    await expect(extract()).resolves.toMatchObject({ text: "fixture result" });
  });
  expect(fs.readFileSync(events, "utf8")).toBe("evaluated\nextracted\nextracted\n");
});

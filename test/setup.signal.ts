import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../src/plugins/current-plugin-metadata.test-support.js";
import { loadPluginManifest } from "../src/plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../src/plugins/plugin-metadata.test-support.js";

const loaded = loadPluginManifest(fileURLToPath(new URL("../extensions/signal", import.meta.url)));
if (!loaded.ok) {
  throw new Error(loaded.error);
}
const manifest = loaded.manifest;

beforeEach(() => {
  setCurrentPluginMetadataSnapshot(createPluginMetadataSnapshotFixture({ plugins: [manifest] }));
});
afterEach(() => setCurrentPluginMetadataSnapshot(undefined));

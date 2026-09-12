import { afterEach, beforeEach } from "vitest";
import manifest from "../extensions/signal/openclaw.plugin.json" with { type: "json" };
import { setCurrentPluginMetadataSnapshot } from "../src/plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../src/plugins/plugin-metadata.test-support.js";

beforeEach(() => {
  setCurrentPluginMetadataSnapshot(createPluginMetadataSnapshotFixture({ plugins: [manifest] }));
});
afterEach(() => setCurrentPluginMetadataSnapshot(undefined));

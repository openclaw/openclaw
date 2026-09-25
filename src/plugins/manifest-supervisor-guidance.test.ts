import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(roots);
});

function discover(supervisorGuidance: unknown) {
  const rootDir = makeTrackedTempDir("openclaw-supervisor-manifest", roots);
  const source = path.join(rootDir, "index.js");
  fs.writeFileSync(source, 'throw new Error("must not activate runtime");');
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "deployment",
      configSchema: { type: "object" },
      supervisorGuidance,
    }),
  );
  return loadPluginManifestRegistryCore({
    installRecords: {},
    candidates: [{ idHint: "deployment", rootDir, source, origin: "config" }],
  });
}

describe("supervisor guidance manifest discovery", () => {
  it("carries the config key to the metadata registry without executing plugin code", () => {
    expect(discover({ configKey: "guidance" }).plugins).toEqual([
      expect.objectContaining({
        id: "deployment",
        supervisorGuidance: { configKey: "guidance" },
      }),
    ]);
  });

  it.each([
    { version: 2, configKey: "guidance" },
    { configKey: "guidance", command: "run" },
    { configKey: "" },
    { configKey: "__proto__" },
  ])("keeps the plugin discoverable but ignores malformed guidance metadata (%#)", (value) => {
    const registry = discover(value);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.supervisorGuidance).toBeUndefined();
  });
});

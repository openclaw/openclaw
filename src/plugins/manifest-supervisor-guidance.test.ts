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
  it("carries package-owned copy to the metadata registry without executing plugin code", () => {
    const guidance = { version: 1, name: "Deployment manager", actions: { start: "deploy start" } };
    expect(discover(guidance).plugins).toEqual([
      expect.objectContaining({ id: "deployment", supervisorGuidance: guidance }),
    ]);
  });

  it.each([
    { configKey: "guidance" },
    { version: 2, name: "Deployment manager", actions: { start: "deploy start" } },
    { version: 1, name: "Deployment manager", actions: {} },
    { version: 1, name: "Deployment manager", actions: { start: "unsafe\ncommand" } },
  ])("keeps the plugin discoverable but ignores malformed guidance metadata (%#)", (value) => {
    const registry = discover(value);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.supervisorGuidance).toBeUndefined();
  });
});

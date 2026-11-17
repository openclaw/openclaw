import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginManifest } from "./manifest.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

const source = {
  id: "repositories",
  label: "Example repositories",
  searchMethod: "example.search",
};

function fixture(repositorySources: unknown) {
  const plugin = writePlugin({ id: "repository-example", registration: "" });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", additionalProperties: false },
      repositorySources,
    }),
  );
  return plugin;
}

it("retains repository discovery without a browser entrypoint through plugin loading", () => {
  useNoBundledPlugins();
  const plugin = fixture([source]);
  const registry = loadOpenClawPlugins({
    cache: false,
    workspaceDir: plugin.dir,
    config: { plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] } },
    onlyPluginIds: [plugin.id],
  });
  expect(registry.plugins.find((record) => record.id === plugin.id)).toMatchObject({
    status: "loaded",
    repositorySources: [source],
    controlUi: undefined,
  });
});

it.each([
  { name: "null declaration", repositorySources: null },
  { name: "duplicate ids", repositorySources: [source, source] },
  { name: "unsafe id", repositorySources: [{ ...source, id: "../escape" }] },
  { name: "empty label", repositorySources: [{ ...source, label: " " }] },
  { name: "empty search method", repositorySources: [{ ...source, searchMethod: " " }] },
  { name: "credential field", repositorySources: [{ ...source, credential: "not-metadata" }] },
  {
    name: "too many sources",
    repositorySources: Array.from({ length: 17 }, (_, index) => ({
      ...source,
      id: `source-${index}`,
    })),
  },
])("rejects repository discovery with $name", ({ repositorySources }) => {
  expect(loadPluginManifest(fixture(repositorySources).dir)).toMatchObject({
    ok: false,
    error: expect.stringContaining("repositorySources"),
  });
});

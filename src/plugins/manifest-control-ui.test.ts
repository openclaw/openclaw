import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function fixture(controlUi: unknown, uiCapabilities?: unknown) {
  const plugin = writePlugin({
    id: "native-ui",
    body: 'module.exports = { id: "native-ui", register() {} };',
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", additionalProperties: false },
      controlUi,
      uiCapabilities,
    }),
  );
  return plugin;
}

describe("native Control UI manifest", () => {
  it("carries normalized built entrypoints through discovery into runtime ownership", () => {
    useNoBundledPlugins();
    const plugin = fixture(
      {
        entry: "./dist/control-ui/index.js",
        styles: ["./dist/control-ui/theme.css", "dist/control-ui/theme.css"],
      },
      ["widget", "page", "widget"],
    );
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: { plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] } },
      onlyPluginIds: [plugin.id],
    });
    expect(registry.plugins.find((record) => record.id === plugin.id)).toMatchObject({
      status: "loaded",
      uiCapabilities: ["page", "widget"],
      controlUi: { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/theme.css"] },
    });
  });

  it.each([
    { declaration: undefined, expected: undefined },
    { declaration: [], expected: [] },
    { declaration: ["link-reader", "page", "link-reader"], expected: ["page", "link-reader"] },
  ])(
    "reads static UI capabilities without a browser module: $declaration",
    ({ declaration, expected }) => {
      const result = loadPluginManifest(fixture(undefined, declaration).dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.uiCapabilities).toEqual(expected);
        expect(result.manifest.controlUi).toBeUndefined();
      }
    },
  );

  it.each([
    { declaration: null },
    { declaration: "page" },
    { declaration: ["pages"] },
    { declaration: ["page", 1] },
  ])(
    "keeps an installed plugin discoverable with invalid optional UI metadata $declaration",
    ({ declaration }) => {
      const plugin = fixture(undefined, declaration);
      const result = loadPluginManifest(plugin.dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.uiCapabilities).toBeUndefined();
      }
      const registry = loadPluginManifestRegistryCore({
        installRecords: {},
        candidates: [
          {
            idHint: plugin.id,
            rootDir: plugin.dir,
            source: plugin.file,
            origin: "global",
          },
        ],
      });
      expect(registry.plugins).toEqual([
        expect.objectContaining({ id: plugin.id, uiCapabilities: undefined }),
      ]);
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "warn",
          pluginId: plugin.id,
          source: path.join(plugin.dir, "openclaw.plugin.json"),
          message: expect.stringContaining("ignoring invalid plugin manifest uiCapabilities"),
        }),
      );
      expect(registry.diagnostics.some((diagnostic) => diagnostic.level === "error")).toBe(false);
    },
  );

  it.each([
    { entry: "src/index.ts" },
    { entry: "dist/index.js" },
    { entry: "../dist/control-ui/index.js" },
    { entry: "/dist/control-ui/index.js" },
    { entry: "dist/control-ui/../server.js" },
    { entry: "dist\\control-ui\\index.js" },
    { entry: "dist/control-ui/index.js", styles: ["dist/server.css"] },
    { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/.secret.css"] },
    { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/code.js"] },
    { entry: "dist/control-ui/index.js", root: "/private" },
  ])("rejects unsafe or source declarations %j", (controlUi) => {
    expect(loadPluginManifest(fixture(controlUi).dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("controlUi"),
    });
  });
});

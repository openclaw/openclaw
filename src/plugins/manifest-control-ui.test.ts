import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { writeFixtureJson as writeJson } from "./loader-fixture-builders.test-support.js";
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
const entry = "dist/control-ui/index.js";
const memoryViews = (...panels: string[]) => panels.map((panel) => ({ section: "memory", panel }));

function fixture(controlUi: unknown, uiCapabilities?: unknown, channels?: string[]) {
  const plugin = writePlugin({ id: "native-ui", registration: "" });
  writeJson(plugin.dir, "openclaw.plugin.json", {
    id: plugin.id,
    configSchema: { type: "object", additionalProperties: false },
    controlUi,
    uiCapabilities,
    channels,
  });
  return plugin;
}

function readManifest(controlUi: unknown, uiCapabilities?: unknown, channels?: string[]) {
  return loadPluginManifest(fixture(controlUi, uiCapabilities, channels).dir);
}

function expectCapabilities(result: ReturnType<typeof loadPluginManifest>, expected?: unknown) {
  expect(result.ok).toBe(true);
  if (result.ok) {
    const { uiCapabilities, controlUi } = result.manifest;
    expect([uiCapabilities, controlUi]).toEqual([expected, undefined]);
  }
}

it("admits channel detail presentations only for the manifest's declared channels", () => {
  const view = { section: "channels", panel: "detail", channelId: "custom" };
  const controlUi = { entry, activation: "settings-only", settingsViews: [view] };
  expect(readManifest(controlUi, undefined, ["custom"])).toMatchObject({
    ok: true,
    manifest: { controlUi },
  });
  expect(readManifest(controlUi, undefined, ["other"])).toMatchObject({ ok: false });
  const duplicate = { ...controlUi, settingsViews: [view, view] };
  expect(readManifest(duplicate, undefined, ["custom"])).toMatchObject({ ok: false });
});

it("carries normalized built entrypoints through discovery into runtime ownership", () => {
  useNoBundledPlugins();
  const style = "dist/control-ui/theme.css";
  const plugin = fixture({ entry: `./${entry}`, styles: [`./${style}`, style] }, [
    "widget",
    "page",
    "widget",
  ]);
  const registry = loadOpenClawPlugins({
    cache: false,
    workspaceDir: plugin.dir,
    config: { plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] } },
    onlyPluginIds: [plugin.id],
  });
  expect(registry.plugins.find((record) => record.id === plugin.id)).toMatchObject({
    status: "loaded",
    uiCapabilities: ["page", "widget"],
    controlUi: { entry, styles: [style] },
  });
});

it.each([[["overview"]], [["memories"]], [["overview", "memories"]]])(
  "preserves settings-only presentations: %j",
  (panels) => {
    const controlUi = {
      entry,
      activation: "settings-only",
      settingsViews: memoryViews(...panels),
    };
    expect(readManifest(controlUi)).toMatchObject({ ok: true, manifest: { controlUi } });
  },
);

it.each([
  [undefined, undefined, false],
  [[], [], false],
  [["link-reader", "page", "link-reader"], ["page", "link-reader"], false],
  [null, undefined, true],
  ["page", undefined, true],
  [["pages"], undefined, true],
  [["page", 1], undefined, true],
] as const)("loads optional UI capabilities: %j", (declaration, expected, invalid) => {
  const plugin = fixture(undefined, declaration);
  expectCapabilities(loadPluginManifest(plugin.dir), expected);
  if (!invalid) {
    return;
  }
  const registry = loadPluginManifestRegistryCore({
    installRecords: {},
    candidates: [{ idHint: plugin.id, rootDir: plugin.dir, source: plugin.file, origin: "global" }],
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
});

it.each([
  { activation: "settings-only" },
  { settingsViews: [] },
  { settingsViews: memoryViews("memories", "memories") },
  { activation: "on-startup" },
  { settingsViews: [{ section: "memory", panel: "search" }] },
  { settingsViews: memoryViews("overview", "overview") },
  { entry: "src/index.ts" },
  { entry: "dist/index.js" },
  { entry: "../dist/control-ui/index.js" },
  { entry: "/dist/control-ui/index.js" },
  { entry: "dist/control-ui/../server.js" },
  { entry: "dist\\control-ui\\index.js" },
  { styles: ["dist/server.css"] },
  { styles: ["dist/control-ui/.secret.css"] },
  { styles: ["dist/control-ui/code.js"] },
  { root: "/private" },
])("rejects unsafe or source declarations %j", (overrides) => {
  expect(readManifest({ entry, ...overrides })).toMatchObject({
    ok: false,
    error: expect.stringContaining("controlUi"),
  });
});

it.each([true, false])("gates generated browser paths on the build: %s", (build) => {
  const controlUi = { entry: "dist/control-ui/prebuilt/index.js" };
  const plugin = fixture(controlUi);
  writeJson(plugin.dir, "package.json", {
    openclaw: { controlUi: build ? "./browser.ts" : undefined },
  });
  fs.mkdirSync(path.join(plugin.dir, "dist"));
  writeJson(plugin.dir, "dist/openclaw.plugin.json", {
    controlUi: { entry: build ? "../another-plugin/dist/control-ui/index.js" : entry },
  });
  expect(loadPluginManifest(plugin.dir)).toMatchObject(
    build
      ? { ok: false, error: expect.stringContaining("controlUi.entry") }
      : { ok: true, manifest: { controlUi } },
  );
});

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { setSharedControlUiE2eServerBaseUrl } from "./control-ui-e2e-shared-preview.ts";
import { prepareNativePluginMockGatewayScenario } from "./control-ui-plugin-e2e.ts";
import { prepareNativeControlUiPluginFixtures } from "./control-ui-plugin-fixture.ts";

const { buildPluginControlUi } = vi.hoisted(() => ({
  buildPluginControlUi: vi.fn(async (_params: { rootDir: string; source: string }) => ({
    entry: "dist/control-ui/prepared/index.js",
  })),
}));
// mock-isolation: Avoid real compiler work while asset loading and validation stay real.
vi.mock("../../../src/cli/plugins-control-ui-build.js", () => ({ buildPluginControlUi }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => setSharedControlUiE2eServerBaseUrl(null));

it("reuses the invocation's matching build while reading each caller's assets and metadata", async () => {
  const root = tempDirs.make("control-ui-prepared-plugin-");
  const rootDir = path.join(root, "prepared");
  const privateRoot = path.join(root, "private");
  const entry = "dist/control-ui/prepared/index.js";
  for (const directory of [rootDir, privateRoot]) {
    await mkdir(path.dirname(path.join(directory, entry)), { recursive: true });
    await writeFile(path.join(directory, entry), "export const current = 1;");
  }
  const fixture = { rootDir, source: "browser/index.ts", pluginId: "shared" };
  setSharedControlUiE2eServerBaseUrl("http://fixture.invalid/", null, [
    { rootDir, source: fixture.source, declaration: { entry } },
  ]);
  const first = await prepareNativeControlUiPluginFixtures([
    { ...fixture, inlineViews: [{ id: "details", label: "Details", version: 1 }] },
  ]);
  expect(buildPluginControlUi).not.toHaveBeenCalled();
  expect(first.catalog.plugins[0]?.entryUrl).toBe(
    "/__openclaw__/plugins/control-ui/shared/prepared/index.js",
  );
  expect(first.catalog.inlineViews).toEqual([
    { pluginId: "shared", id: "details", label: "Details", version: 1 },
  ]);
  expect([...first.assets.values()][0]?.body.toString()).toBe("export const current = 1;");

  await writeFile(path.join(rootDir, entry), "export const current = 2;");
  const next = await prepareNativeControlUiPluginFixtures([
    { ...fixture, pluginId: "renamed", inlineViews: [] },
  ]);
  expect(buildPluginControlUi).not.toHaveBeenCalled();
  expect(next.catalog.inlineViews).toEqual([]);
  expect(next.catalog.plugins[0]?.entryUrl).toContain("/renamed/");
  expect([...next.assets.values()][0]?.body.toString()).toBe("export const current = 2;");

  await prepareNativeControlUiPluginFixtures([{ ...fixture, source: "browser/other.ts" }]);
  await prepareNativeControlUiPluginFixtures([{ ...fixture, rootDir: privateRoot }]);
  expect(buildPluginControlUi).toHaveBeenCalledTimes(2);

  await rm(path.join(rootDir, entry));
  await expect(prepareNativeControlUiPluginFixtures([fixture])).rejects.toThrow(
    "declared browser assets are missing",
  );
});

it.each([false, true])(
  "does not advertise settings-only views for activation (mixed: %s)",
  async (mixed) => {
    const root = tempDirs.make("control-ui-settings-fixture-");
    const entry = "dist/control-ui/prepared/index.js";
    const source = "browser/index.ts";
    const settings = { rootDir: path.join(root, "settings"), source, pluginId: "settings" };
    const active = { rootDir: path.join(root, "active"), source, pluginId: "active" };
    const fixtures = mixed ? [settings, active] : [settings];
    for (const fixture of fixtures) {
      const target = path.join(fixture.rootDir, entry);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "export const settingsViews = [];");
    }
    setSharedControlUiE2eServerBaseUrl("http://fixture.invalid/", null, [
      {
        ...settings,
        declaration: {
          entry,
          activation: "settings-only",
          settingsViews: [{ section: "memory", panel: "overview" }],
        },
      },
      { ...active, declaration: { entry } },
    ]);
    const { assets, scenario } = await prepareNativePluginMockGatewayScenario({
      nativePlugins: fixtures,
    });
    expect(scenario.featureMethods).toContain("plugins.controlUi.list");
    expect(scenario.methodResponses?.["plugins.controlUi.list"]).toMatchObject({
      plugins: mixed ? [expect.objectContaining({ pluginId: "active" })] : [],
    });
    expect(assets.has("/__openclaw__/plugins/control-ui/settings/prepared/index.js")).toBe(true);
  },
);

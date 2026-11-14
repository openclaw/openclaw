import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { setSharedControlUiE2eServerBaseUrl } from "./control-ui-e2e-shared-preview.ts";
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

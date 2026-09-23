import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as activationRuntime from "./facade-activation-check.runtime.js";
import {
  listImportedBundledPluginFacadeIds,
  loadActivatedBundledPluginPublicSurfaceModule,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest,
  testing,
} from "./facade-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activationLoaders = [
  ["sync", loadActivatedBundledPluginPublicSurfaceModuleSync],
  ["async", loadActivatedBundledPluginPublicSurfaceModule],
] as const;

it.each(
  activationLoaders.flatMap(([kind, load]) =>
    [
      { defaults: "unconditional defaults", manifest: { enabledByDefault: true }, paddedId: false },
      {
        defaults: "platform defaults",
        manifest: { enabledByDefaultOnPlatforms: [` ${process.platform} `, "not-a-platform"] },
        paddedId: false,
      },
      { defaults: "normalized IDs", manifest: { enabledByDefault: true }, paddedId: true },
    ].map(({ defaults, manifest, paddedId }) => ({ defaults, manifest, paddedId, kind, load })),
  ),
)(
  "$kind activation with $defaults preserves policy errors, cached exports, and artifact failures",
  async ({ load, manifest, paddedId }) => {
    const bundledRoot = path.resolve("dist-runtime", "extensions");
    fs.mkdirSync(bundledRoot, { recursive: true });
    const root = fs.realpathSync(tempDirs.make(".activation-", bundledRoot));
    for (const id of ["fixture", "broken", "other-platform"]) {
      const pluginRoot = path.join(root, id);
      fs.mkdirSync(pluginRoot);
      fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n');
      fs.writeFileSync(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: paddedId && id === "fixture" ? ` ${id} ` : id,
          ...(id === "other-platform"
            ? { enabledByDefaultOnPlatforms: [process.platform === "darwin" ? "linux" : "darwin"] }
            : id === "broken"
              ? { enabledByDefault: true }
              : manifest),
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "api.js"),
        id === "fixture"
          ? 'exports.marker = "activated";\n'
          : `throw new Error(${JSON.stringify(id === "broken" ? "plugin load failure" : "wrong platform artifact evaluated")});\n`,
      );
    }
    resetFacadeRuntimeStateForTest();
    testing.setFacadeActivationCheckRuntimeForTest(activationRuntime);
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
    const params = { dirName: "fixture", artifactBasename: "api.js" };
    const invoke = (request = params) => Promise.resolve().then(() => load(request));
    try {
      setRuntimeConfigSnapshot({});
      await expect(
        invoke({ dirName: "missing-fixture", artifactBasename: "api.js" }),
      ).rejects.toEqual(
        new Error(
          'Bundled plugin public surface access blocked for "missing-fixture" via missing-fixture/api.js: no bundled plugin manifest found for missing-fixture',
        ),
      );
      await expect(
        invoke({ dirName: "other-platform", artifactBasename: "api.js" }),
      ).rejects.toThrow(/Bundled plugin public surface access blocked.*disabled by default/);
      await expect(invoke({ dirName: "broken", artifactBasename: "api.js" })).rejects.toThrow(
        "plugin load failure",
      );
      expect(listImportedBundledPluginFacadeIds()).toEqual([]);
      const loaded = await invoke();
      expect(loaded).toEqual({ marker: "activated" });
      expect(await invoke()).toBe(loaded);
      expect(listImportedBundledPluginFacadeIds()).toEqual(["fixture"]);

      setRuntimeConfigSnapshot({ plugins: { entries: { fixture: { enabled: false } } } });
      await expect(invoke()).rejects.toEqual(
        new Error(
          'Bundled plugin public surface access blocked for "fixture" via fixture/api.js: disabled in config',
        ),
      );
      setRuntimeConfigSnapshot({});
      expect(await invoke()).toBe(loaded);
    } finally {
      clearRuntimeConfigSnapshot();
      resetFacadeRuntimeStateForTest();
      vi.unstubAllEnvs();
    }
  },
);

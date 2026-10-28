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
import { writeFacadeFiles } from "./facade-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each(["sync", "async"])(
  "%s activation preserves policy errors, cached exports, and artifact failures",
  async (kind) => {
    const load =
      kind === "sync"
        ? loadActivatedBundledPluginPublicSurfaceModuleSync
        : loadActivatedBundledPluginPublicSurfaceModule;
    const manifest =
      kind === "sync"
        ? {
            id: "fixture",
            enabledByDefaultOnPlatforms: [` ${process.platform} `, "not-a-platform"],
          }
        : { id: " fixture ", enabledByDefault: true };
    const bundledRoot = path.resolve("dist-runtime", "extensions");
    fs.mkdirSync(bundledRoot, { recursive: true });
    const root = fs.realpathSync(tempDirs.make(".activation-", bundledRoot));
    for (const id of ["fixture", "broken", "other-platform"]) {
      writeFacadeFiles(path.join(root, id), {
        "package.json": { type: "commonjs" },
        "openclaw.plugin.json": {
          id,
          ...(id === "other-platform"
            ? { enabledByDefaultOnPlatforms: [process.platform === "darwin" ? "linux" : "darwin"] }
            : id === "broken"
              ? { enabledByDefault: true }
              : manifest),
        },
        "api.js":
          id === "fixture"
            ? 'exports.marker = "activated";\n'
            : `throw new Error(${JSON.stringify(id === "broken" ? "plugin load failure" : "wrong platform artifact evaluated")});\n`,
      });
    }
    resetFacadeRuntimeStateForTest();
    testing.setFacadeActivationCheckRuntimeForTest(activationRuntime);
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", root);
    const invoke = (dirName = "fixture") =>
      Promise.resolve().then(() => load({ dirName, artifactBasename: "api.js" }));
    try {
      setRuntimeConfigSnapshot({});
      await expect(invoke("missing-fixture")).rejects.toEqual(
        new Error(
          'Bundled plugin public surface access blocked for "missing-fixture" via missing-fixture/api.js: no bundled plugin manifest found for missing-fixture',
        ),
      );
      await expect(invoke("other-platform")).rejects.toThrow(
        /Bundled plugin public surface access blocked.*disabled by default/,
      );
      await expect(invoke("broken")).rejects.toThrow("plugin load failure");
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

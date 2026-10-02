import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nativeModule from "../plugins/native-module-require.js";
import {
  listImportedBundledPluginFacadeIds,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([undefined, "MODULE_NOT_FOUND"])(
  "does not replay failed activation initialization (%s)",
  (code) => {
    const root = tempDirs.make("openclaw-facade-initialization-");
    const sidecar = path.join(root, "activation.cjs");
    const marker = path.join(root, "evaluations.txt");
    const message = "activation dependency failed during evaluation";
    fs.writeFileSync(
      sidecar,
      [
        `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "evaluated\\n");`,
        `throw Object.assign(new Error(${JSON.stringify(message)}), ${JSON.stringify(code ? { code } : {})});`,
      ].join("\n"),
    );
    resetFacadeRuntimeStateForTest();
    const require = Module.createRequire(import.meta.url);
    // Keep this caller-boundary regression on the tiny sidecar; the shared loader
    // independently covers native/source selection and terminal error handling.
    const nativeLoad = nativeModule.tryNativeRequireModule;
    vi.spyOn(nativeModule, "tryNativeRequireModule").mockImplementation((specifier, options) =>
      /facade-activation-check\.runtime\.[jt]s$/u.test(specifier)
        ? { ok: true, moduleExport: require(sidecar) }
        : nativeLoad(specifier, options),
    );
    try {
      let failure: unknown;
      try {
        loadActivatedBundledPluginPublicSurfaceModuleSync({
          dirName: "fixture",
          artifactBasename: "api.js",
        });
      } catch (error) {
        failure = error;
      }
      expect(fs.readFileSync(marker, "utf8")).toBe("evaluated\n");
      expect(failure).toMatchObject({
        message: "Unable to load facade activation check runtime",
        cause: { message, ...(code ? { code } : {}) },
      });
      expect(listImportedBundledPluginFacadeIds()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      resetFacadeRuntimeStateForTest();
    }
  },
);

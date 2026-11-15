import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { getCachedPluginModuleLoader, preparePluginModule } from "./plugin-module-loader-cache.js";

vi.mock("../../standalone-runtime-profile.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../standalone-runtime-profile.mjs")>()),
  getRuntimeExecutionProfile: () => "embedded-aot",
}));

const temp = useAutoCleanupTempDirTracker(afterEach);

describe("plugin loading in the embedded AOT profile", () => {
  it.each(["cjs", "ts"])("loads fetched %s code through the normal loader", (extension) => {
    const root = temp.make("plugin-runtime-profile-");
    const entry = path.join(root, `index.${extension}`);
    const marker = path.join(root, "executed");
    fs.writeFileSync(
      entry,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); module.exports = { value: 42 };`,
    );
    withPluginCache(createPluginCache(), () => {
      const load = getCachedPluginModuleLoader({
        modulePath: entry,
        importerUrl: import.meta.url,
        aliasMap: {},
        tryNative: true,
      });
      expect(load(entry)).toEqual({ value: 42 });
      expect(load(entry)).toEqual({ value: 42 });
      expect(fs.readFileSync(marker, "utf8")).toBe("executed");
      expect(() =>
        preparePluginModule({
          modulePath: entry,
          boundaryRoot: root,
          boundaryLabel: "plugin root",
          rejectHardlinks: true,
          surfaceLabel: "plugin public surface",
        }),
      ).not.toThrow();
    });
  });
});

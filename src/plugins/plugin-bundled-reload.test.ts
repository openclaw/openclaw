import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginCache, waitForPluginCacheRetirement } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
// Registry retirement owns hooks and captures; tests settle the same owner.
afterEach(async () => {
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
  resetPluginCache();
  await waitForPluginCacheRetirement();
});
type Probe = { value: string; increment: () => number; late: () => Promise<string> };

it.each(["source-ts", "compiled-cjs", "compiled-esm", "runtime-overlay"])(
  "reloads %s code with host identity and recoverable source bytes",
  async (layout) => {
    const root = temp.make("bundled-reload-source-");
    const captures = temp.make("bundled-reload-captures-");
    const compiled = layout !== "source-ts";
    const cjs = layout === "compiled-cjs";
    const suffix = cjs ? "cjs" : layout === "source-ts" ? "ts" : "mjs";
    const plugin = path.join(root, compiled ? "dist/extensions/demo" : "extensions/demo");
    const entry = path.join(plugin, `index.${suffix}`);
    const shared = path.join(root, compiled ? "dist/shared.cjs" : "shared.cjs");
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(shared, "module.exports = { count: 0 };\n");
    if (compiled) {
      fs.writeFileSync(
        path.join(root, "dist/runtime-dependency-ownership.json"),
        JSON.stringify({ chunks: {} }),
      );
    }
    const host = createRequire(import.meta.url)(shared);
    const writeVersion = (version: string) => {
      if (compiled) {
        const chunk = cjs ? `exports.chunk = "${version}";` : `export const chunk = "${version}";`;
        fs.writeFileSync(path.join(root, "dist", `owned.${suffix}`), chunk);
        fs.writeFileSync(
          path.join(root, "dist/runtime-dependency-ownership.json"),
          JSON.stringify({
            chunks: {
              [`owned.${suffix}`]: {
                sha256: createHash("sha256").update(chunk).digest("hex"),
                extensions: ["demo"],
              },
            },
          }),
        );
      }
      fs.writeFileSync(
        path.join(plugin, `helper.${suffix}`),
        cjs ? `exports.value = "${version}";` : `export const value = "${version}";`,
      );
      fs.writeFileSync(
        path.join(plugin, `late.${suffix}`),
        cjs ? `exports.value = "${version} late";` : `export const value = "${version} late";`,
      );
    };
    const chunkImport = compiled
      ? cjs
        ? `const { chunk } = require("../../owned.${suffix}");`
        : `import { chunk } from "../../owned.${suffix}";`
      : `const chunk = value;`;
    fs.writeFileSync(
      entry,
      cjs
        ? `const shared = require("../../shared.cjs"); const { value } = require("./helper.cjs"); ${chunkImport} module.exports = { increment: () => ++shared.count, value: value + chunk, late: async () => require("./late.cjs").value };`
        : `import shared from "../../shared.cjs"; import { value } from "./helper.${suffix}"; ${chunkImport} export default { increment: () => ++shared.count, value: value + chunk, late: async () => (await import("./late.${suffix}")).value };`,
    );
    let selectedEntry = entry;
    let selectedRoot = plugin;
    if (layout === "runtime-overlay") {
      selectedRoot = path.join(root, "dist-runtime/extensions/demo");
      selectedEntry = path.join(selectedRoot, "index.mjs");
      fs.mkdirSync(selectedRoot, { recursive: true });
      fs.writeFileSync(
        selectedEntry,
        `export { default } from "../../../dist/extensions/demo/index.mjs";`,
      );
    }
    const create = () =>
      withPluginSourceCaptureDirectory(captures, () => {
        const instance = new PluginInstance("demo");
        instances.push(instance);
        bindPluginInstanceModuleLoader({
          instance,
          origin: "bundled",
          source: selectedEntry,
          rootDir: selectedRoot,
          reloadBundledCode: true,
        });
        return instance;
      });
    const load = (instance: PluginInstance): Probe => {
      const module = instance.loadModule(selectedEntry) as Probe & { default?: Probe };
      return module.default ?? module;
    };
    writeVersion("A");
    const first = create();
    expect(load(first).value).toBe("AA");
    expect(load(first).increment()).toBe(1);
    expect(host.count).toBe(1);
    writeVersion("B");
    const second = create();
    expect(load(second).value).toBe("BB");
    expect(load(second).increment()).toBe(2);
    expect(host.count).toBe(2);
    expect(await second.run(() => load(second).late())).toBe("B late");
    const recovery = withPluginSourceCaptureDirectory(captures, () =>
      second.captureModuleLoaderRecovery(),
    );
    await second.dispose();
    fs.rmSync(plugin, { recursive: true });
    const restored = new PluginInstance("demo");
    instances.push(restored);
    withPluginSourceCaptureDirectory(captures, () => recovery.bind(restored));
    expect(load(restored).value).toBe("BB");
    expect(load(restored).increment()).toBe(3);
    expect(host.count).toBe(3);
    expect(await restored.run(() => load(restored).late())).toBe("B late");
  },
);

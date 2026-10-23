import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  bundledPluginCaptureInputs,
  resolveBundledPluginReloadSource,
} from "./plugin-bundled-reload.js";
import { resetPluginCache, waitForPluginCacheRetirement } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
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
  vi.restoreAllMocks();
});
type Probe = { value: string; increment: () => number; late: () => Promise<string> };

it("leaves absolute host imports outside a captured dependency's package untouched", async () => {
  const root = temp.make("bundled-reload-dependency-source-");
  const captures = temp.make("bundled-reload-dependency-captures-");
  const plugin = path.join(root, "extensions/demo");
  const entry = path.join(plugin, "index.mjs");
  const dependency = path.join(root, "node_modules/bridge");
  const dependencyEntry = path.join(dependency, "index.mjs");
  const shared = path.join(root, "shared.cjs");
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "bridge", type: "module", main: "index.mjs" }),
  );
  fs.writeFileSync(entry, 'import "bridge";');
  fs.writeFileSync(shared, "module.exports = 'canonical host';");
  fs.writeFileSync(dependencyEntry, `export const read = () => import(${JSON.stringify(shared)});`);
  const policy = resolveBundledPluginReloadSource(plugin);
  const artifact = withPluginSourceCaptureDirectory(captures, () =>
    capturePluginGenerationArtifact(
      ...bundledPluginCaptureInputs(plugin, entry, policy, false, false),
      (run) => run(),
      undefined,
      undefined,
      undefined,
      policy,
    ),
  );
  try {
    const capturedDependency = artifact.captureResolvedModule(dependencyEntry)!;
    artifact.prepareModule(capturedDependency);
    artifact.captureModule(capturedDependency, shared, ["node", "module-sync", "import"]);
    expect(fs.existsSync(path.resolve(path.dirname(capturedDependency), "../../shared.cjs"))).toBe(
      false,
    );
    expect(fs.readFileSync(shared, "utf8")).toBe("module.exports = 'canonical host';");
  } finally {
    await artifact.disposeAsync();
  }
});

it("keeps host shared imports available to bundled Workers across recovery and disposal", async () => {
  const root = temp.make("bundled-reload-worker-source-");
  const captures = temp.make("bundled-reload-worker-captures-");
  const plugin = path.join(root, "dist/extensions/demo");
  const entry = path.join(plugin, "index.mjs");
  const shared = path.join(root, "dist/shared.cjs");
  const sharedBytes = "module.exports = { count: 0, marker: 'host shared worker dependency' };\n";
  const workerPath = path.join(root, "dist/owned.worker.mjs");
  const workerBytes = `import { parentPort } from "node:worker_threads";
    import shared from "./shared.cjs";
    parentPort.postMessage(shared.marker);`;
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(shared, sharedBytes);
  fs.writeFileSync(workerPath, workerBytes);
  fs.writeFileSync(
    path.join(root, "dist/runtime-dependency-ownership.json"),
    JSON.stringify({
      chunks: {
        "owned.worker.mjs": {
          sha256: createHash("sha256").update(workerBytes).digest("hex"),
          extensions: ["demo"],
        },
      },
    }),
  );
  fs.writeFileSync(
    entry,
    `import shared from "../../shared.cjs";
    import { readFileSync } from "node:fs";
    export default { increment: () => ++shared.count,
      sharedSource: readFileSync(new URL("../../shared.cjs", import.meta.url), "utf8"),
      workerUrl: new URL("../../owned.worker.mjs", import.meta.url) };`,
  );
  const host = createRequire(import.meta.url)(shared);
  const create = () =>
    withPluginSourceCaptureDirectory(captures, () => {
      const instance = new PluginInstance("demo");
      instances.push(instance);
      bindPluginInstanceModuleLoader({
        instance,
        origin: "bundled",
        source: entry,
        rootDir: plugin,
        reloadBundledCode: true,
      });
      return instance;
    });
  const load = (instance: PluginInstance) =>
    (
      instance.loadModule(entry) as {
        default: { increment(): number; sharedSource: string; workerUrl: URL };
      }
    ).default;
  const runWorker = async (url: URL) => {
    const worker = new Worker(fileURLToPath(url.href), { execArgv: [] });
    try {
      const [message] = await once(worker, "message");
      expect(message).toBe("host shared worker dependency");
    } finally {
      await worker.terminate();
    }
  };
  const instance = create();
  expect(load(instance).increment()).toBe(1);
  expect(load(instance).sharedSource).toBe(sharedBytes);
  expect(host.count).toBe(1);
  await runWorker(load(instance).workerUrl);
  const recovery = withPluginSourceCaptureDirectory(captures, () =>
    instance.captureModuleLoaderRecovery(),
  );
  await instance.dispose();
  fs.rmSync(plugin, { recursive: true });
  fs.rmSync(workerPath);
  const restored = new PluginInstance("demo");
  instances.push(restored);
  withPluginSourceCaptureDirectory(captures, () => recovery.bind(restored));
  expect(load(restored).increment()).toBe(2);
  expect(load(restored).sharedSource).toBe(sharedBytes);
  expect(host.count).toBe(2);
  await runWorker(load(restored).workerUrl);
  await restored.dispose();
  expect(fs.readFileSync(shared, "utf8")).toBe(sharedBytes);
});

it.each([
  "source-ts",
  "compiled-cjs",
  "compiled-esm",
  "runtime-overlay",
  "compiled-esm-no-file-links",
])("reloads %s code with host identity and recoverable source bytes", async (layout) => {
  let deniedLinks = 0;
  if (layout === "compiled-esm-no-file-links") {
    const symlink = fs.symlinkSync;
    vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) => {
      if (type === "file") {
        deniedLinks++;
        throw Object.assign(new Error("fixture Windows file symlinks are unavailable"), {
          code: "EPERM",
        });
      }
      symlink(target, link, type);
    });
  }
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
  if (layout === "compiled-esm-no-file-links") {
    expect(deniedLinks).toBeGreaterThan(0);
  }
});

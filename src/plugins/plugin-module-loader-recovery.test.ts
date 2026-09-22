import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
  resetPluginCache();
});

function fixture(standalone = false) {
  const root = temp.make("plugin-recovery-source-");
  const captures = temp.make("plugin-recovery-captures-");
  const entry = path.join(root, "index.cjs");
  const dependency = path.join(root, "node_modules", "recovery-dependency");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "recovery-fixture", dependencies: { "recovery-dependency": "1.0.0" } }),
  );
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "recovery-dependency", main: "index.cjs" }),
  );
  fs.writeFileSync(path.join(dependency, "index.cjs"), "exports.value = 'original dependency';");
  fs.writeFileSync(path.join(root, "late.cjs"), "exports.value = 'original late import';");
  fs.writeFileSync(
    entry,
    `const dependency = require('recovery-dependency');
     let count = 0;
     exports.next = () => ++count;
     exports.dependency = () => dependency.value;
     exports.late = () => require('./late.cjs').value;`,
  );
  const instance = new PluginInstance("recovery-fixture");
  instances.push(instance);
  withPluginSourceCaptureDirectory(captures, () =>
    bindPluginInstanceModuleLoader({
      instance,
      origin: "global",
      source: entry,
      rootDir: root,
      standalone,
    }),
  );
  return { root, entry, captures, instance };
}

type FixtureModule = { next(): number; dependency(): string; late(): string };

it.each([false, true])(
  "recovers fresh module state after package removal (standalone: %s)",
  async (standalone) => {
    const { root, entry, captures, instance } = fixture(standalone);
    const oldModule = instance.loadModule(entry) as FixtureModule;
    expect(oldModule.next()).toBe(1);
    expect(oldModule.next()).toBe(2);
    const recovery = withPluginSourceCaptureDirectory(captures, () =>
      instance.captureModuleLoaderRecovery(),
    );
    fs.writeFileSync(entry, "throw new Error('replacement code must not run during recovery');");
    await instance.dispose();
    fs.rmSync(root, { recursive: true });

    const restored = new PluginInstance("recovery-fixture");
    instances.push(restored);
    withPluginSourceCaptureDirectory(captures, () => recovery.bind(restored));
    recovery.dispose();
    const restoredModule = restored.loadModule(entry) as FixtureModule;
    expect(restoredModule.next()).toBe(1);
    expect(restoredModule.dependency()).toBe("original dependency");
    expect(restoredModule.late()).toBe("original late import");
    expect(() => oldModule.next()).toThrow();

    // Recovery remains recoverable itself after another failed update.
    const again = withPluginSourceCaptureDirectory(captures, () =>
      restored.captureModuleLoaderRecovery(),
    );
    await restored.dispose();
    const final = new PluginInstance("recovery-fixture");
    instances.push(final);
    withPluginSourceCaptureDirectory(captures, () => again.bind(final));
    expect((final.loadModule(entry) as FixtureModule).next()).toBe(1);
    expect((final.loadModule(entry) as FixtureModule).late()).toBe("original late import");
    await final.dispose();
    expect(fs.readdirSync(captures)).toEqual([]);
  },
);

it("releases unused recovery custody without disturbing the active loader", async () => {
  const { entry, captures, instance } = fixture();
  const before = fs.readdirSync(captures);
  const recovery = withPluginSourceCaptureDirectory(captures, () =>
    instance.captureModuleLoaderRecovery(),
  );
  expect(fs.readdirSync(captures).length).toBeGreaterThan(before.length);
  recovery.dispose();
  recovery.dispose();
  expect(fs.readdirSync(captures)).toEqual(before);
  expect((instance.loadModule(entry) as FixtureModule).next()).toBe(1);
  expect(() => recovery.bind(new PluginInstance("recovery-fixture"))).toThrow("released");
});

it("captures quiesced code without admitting calls and refuses capture after disposal starts", async () => {
  const { root, entry, captures, instance } = fixture();
  expect((instance.loadModule(entry) as FixtureModule).dependency()).toBe("original dependency");
  instance.quiesce();
  fs.writeFileSync(entry, "throw new Error('changed disk bytes must not become recovery');");
  const recovery = withPluginSourceCaptureDirectory(captures, () =>
    instance.captureModuleLoaderRecovery(),
  );
  expect(() => instance.loadModule(entry)).toThrow(/reloaded or disabled/);
  const disposing = instance.dispose();
  expect(() => instance.captureModuleLoaderRecovery()).toThrow(/reloaded or disabled/);
  await disposing;
  fs.rmSync(root, { recursive: true });
  const restored = new PluginInstance(instance.pluginId);
  instances.push(restored);
  recovery.bind(restored);
  recovery.dispose();
  expect((restored.loadModule(entry) as FixtureModule).dependency()).toBe("original dependency");
  expect((restored.loadModule(entry) as FixtureModule).late()).toBe("original late import");
});

it.each(["cjs", "mjs"])(
  "reuses compiled bundled %s code while giving recovery fresh callback authority",
  async (extension) => {
    const root = temp.make("bundled-recovery-identity-");
    const entry = path.join(root, `index.${extension}`);
    fs.writeFileSync(
      entry,
      `let registrations = 0;
       ${extension === "mjs" ? "export const register =" : "exports.register ="} () => {
         const registration = ++registrations;
         return { read: () => registration };
       };`,
    );
    type BundledModule = { register(): { read(): number } };
    const previous = new PluginInstance("bundled-recovery");
    instances.push(previous);
    bindPluginInstanceModuleLoader({
      instance: previous,
      origin: "bundled",
      source: entry,
      rootDir: root,
    });
    const oldCallback = (previous.loadModule(entry) as BundledModule).register();
    expect(oldCallback.read()).toBe(1);
    const recovery = previous.captureModuleLoaderRecovery();
    await previous.dispose();

    const restored = new PluginInstance(previous.pluginId);
    instances.push(restored);
    recovery.bind(restored);
    recovery.dispose();
    const restoredCallback = (restored.loadModule(entry) as BundledModule).register();
    expect(restoredCallback.read()).toBe(2);
    expect(() => oldCallback.read()).toThrow(/reloaded or disabled/);
    expect(restoredCallback.read()).toBe(2);

    const secondRecovery = restored.captureModuleLoaderRecovery();
    await restored.dispose();
    const final = new PluginInstance(previous.pluginId);
    instances.push(final);
    secondRecovery.bind(final);
    secondRecovery.dispose();
    expect((final.loadModule(entry) as BundledModule).register().read()).toBe(3);
    expect(() => restoredCallback.read()).toThrow(/reloaded or disabled/);
  },
);

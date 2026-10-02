import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginCache, waitForPluginCacheRetirement } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { getSharedPluginCodeReloadWarning } from "./plugin-shared-module-loader.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
  resetPluginCache();
  await waitForPluginCacheRetirement();
  vi.restoreAllMocks();
});

function fixture(standalone = false, nativePackageMap = false) {
  const root = temp.make("plugin-recovery-source-");
  const captures = temp.make("plugin-recovery-captures-");
  const entry = path.join(root, "index.cjs");
  const dependency = path.join(root, "node_modules", "recovery-dependency");
  const nativeDependency = path.join(root, "node_modules", "native-recovery");
  fs.mkdirSync(dependency, { recursive: true });
  fs.mkdirSync(nativeDependency);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "recovery-fixture",
      dependencies: { "recovery-dependency": "1.0.0", "native-recovery": "1.0.0" },
    }),
  );
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "recovery-dependency", main: "index.cjs" }),
  );
  fs.writeFileSync(path.join(dependency, "index.cjs"), "exports.value = 'original dependency';");
  fs.writeFileSync(
    path.join(nativeDependency, "package.json"),
    JSON.stringify({
      name: "native-recovery",
      ...(nativePackageMap ? { exports: "./native.node" } : { main: "native.node" }),
    }),
  );
  fs.writeFileSync(path.join(nativeDependency, "native.node"), "original native dependency");
  fs.writeFileSync(path.join(root, "late.cjs"), "exports.value = 'original late import';");
  fs.writeFileSync(path.join(root, "native.so"), "original native bytes");
  fs.writeFileSync(
    entry,
    `const dependency = require('recovery-dependency');
     const fs = require('node:fs');
     const path = require('node:path');
     let count = 0;
     exports.next = () => ++count;
     exports.dependency = () => dependency.value;
     exports.nativeDependencyPath = () => require.resolve('native-recovery');
     exports.nativePath = path.join(__dirname, 'native.so');
     exports.native = () => fs.readFileSync(path.join(__dirname, 'native.so'), 'utf8');
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

type FixtureModule = {
  next(): number;
  dependency(): string;
  late(): string;
  native(): string;
  nativePath: string;
  nativeDependencyPath(): string;
};

it.each(
  [false, true].flatMap((standalone) =>
    [false, true].map((nativePackageMap) => ({
      standalone,
      nativePackageMap,
      denyFileSymlinks: standalone && nativePackageMap,
    })),
  ),
)(
  "recovers native assets after package removal (standalone: $standalone, exports: $nativePackageMap, file-symlink denied: $denyFileSymlinks)",
  async ({ standalone, nativePackageMap, denyFileSymlinks }) => {
    let deniedLinks = 0;
    if (denyFileSymlinks) {
      const symlink = fs.symlinkSync;
      vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) => {
        if (type === "file") {
          deniedLinks += 1;
          throw Object.assign(new Error("fixture Windows file symlink privilege is unavailable"), {
            code: "EPERM",
          });
        }
        symlink(target, link, type);
      });
    }
    const { root, entry, captures, instance } = fixture(standalone, nativePackageMap);
    const oldModule = instance.loadModule(entry) as FixtureModule;
    expect(oldModule.next()).toBe(1);
    expect(oldModule.next()).toBe(2);
    expect(oldModule.native()).toBe("original native bytes");
    const nativeIdentity = fs.statSync(oldModule.nativePath);
    const dependencyIdentity = fs.statSync(oldModule.nativeDependencyPath());
    if (denyFileSymlinks) {
      const warm = new PluginInstance("recovery-fixture");
      instances.push(warm);
      withPluginSourceCaptureDirectory(captures, () =>
        bindPluginInstanceModuleLoader({
          instance: warm,
          origin: "global",
          source: entry,
          rootDir: root,
          standalone,
        }),
      );
      const warmModule = warm.loadModule(entry) as FixtureModule;
      expect(warmModule.native()).toBe("original native bytes");
      expect(fs.statSync(warmModule.nativePath)).toMatchObject({
        dev: nativeIdentity.dev,
        ino: nativeIdentity.ino,
      });
      expect(fs.readFileSync(warmModule.nativeDependencyPath(), "utf8")).toBe(
        "original native dependency",
      );
      await warm.dispose();
      expect(oldModule.native()).toBe("original native bytes");
    }
    const copiedNative = vi.spyOn(fs, "copyFileSync");
    const nativeRead = vi.spyOn(fs, "readFileSync");
    const nativeShadow = fs.realpathSync(oldModule.nativePath);
    fs.writeFileSync(path.join(root, "native.so"), "replacement native bytes");
    expect(oldModule.native()).toBe("original native bytes");
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
    expect(restoredModule.native()).toBe("original native bytes");
    expect(fs.statSync(restoredModule.nativePath)).toMatchObject({
      dev: nativeIdentity.dev,
      ino: nativeIdentity.ino,
    });
    expect(fs.readFileSync(restoredModule.nativeDependencyPath(), "utf8")).toBe(
      "original native dependency",
    );
    expect(fs.statSync(restoredModule.nativeDependencyPath())).toMatchObject({
      dev: dependencyIdentity.dev,
      ino: dependencyIdentity.ino,
    });
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
    const finalModule = final.loadModule(entry) as FixtureModule;
    expect(finalModule.native()).toBe("original native bytes");
    expect(fs.statSync(finalModule.nativePath)).toMatchObject({
      dev: nativeIdentity.dev,
      ino: nativeIdentity.ino,
    });
    await final.dispose();
    expect(fs.readdirSync(captures)).toEqual([]);
    expect(
      copiedNative.mock.calls.filter(([source]) =>
        /(?:native\.so|native\.node)$/.test(String(source)),
      ),
    ).toHaveLength(0);
    expect(
      nativeRead.mock.calls.filter(([source], index) => {
        const result = nativeRead.mock.results[index];
        return (
          /(?:native\.so|native\.node)$/.test(String(source)) &&
          result?.type === "return" &&
          Buffer.isBuffer(result.value)
        );
      }),
    ).toHaveLength(0);
    if (denyFileSymlinks) {
      expect(deniedLinks).toBeGreaterThan(0);
    }
    resetPluginCache();
    await waitForPluginCacheRetirement();
    expect(fs.existsSync(nativeShadow)).toBe(false);
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
    expect(getSharedPluginCodeReloadWarning(previous)).toBeUndefined();
    const recovery = previous.captureModuleLoaderRecovery();
    await previous.dispose();
    fs.rmSync(root, { recursive: true });

    const restored = new PluginInstance(previous.pluginId);
    instances.push(restored);
    recovery.bind(restored);
    recovery.dispose();
    const restoredCallback = (restored.loadModule(entry) as BundledModule).register();
    expect(restoredCallback.read()).toBe(2);
    expect(getSharedPluginCodeReloadWarning(restored)).toBeUndefined();
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

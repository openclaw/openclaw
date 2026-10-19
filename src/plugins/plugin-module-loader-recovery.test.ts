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
function newInstance(
  id = "recovery-fixture",
  binding?: Omit<Parameters<typeof bindPluginInstanceModuleLoader>[0], "instance">,
) {
  const instance = new PluginInstance(id);
  instances.push(instance);
  if (binding) {
    bindPluginInstanceModuleLoader({ ...binding, instance });
  }
  return instance;
}
function capture(instance: PluginInstance, captures: string) {
  return withPluginSourceCaptureDirectory(captures, () => instance.captureModuleLoaderRecovery());
}
function expectIdentity(filename: string, identity: fs.Stats) {
  expect(fs.statSync(filename)).toMatchObject({ dev: identity.dev, ino: identity.ino });
}
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
  const write = (filename: string, contents: string | object) =>
    fs.writeFileSync(
      path.join(root, filename),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  write("package.json", {
    name: "recovery-fixture",
    dependencies: { "recovery-dependency": "1.0.0", "native-recovery": "1.0.0" },
  });
  write("node_modules/recovery-dependency/package.json", {
    name: "recovery-dependency",
    main: "index.cjs",
  });
  write("node_modules/recovery-dependency/index.cjs", "exports.value = 'original dependency';");
  write("node_modules/native-recovery/package.json", {
    name: "native-recovery",
    ...(nativePackageMap ? { exports: "./native.node" } : { main: "native.node" }),
  });
  write("node_modules/native-recovery/native.node", "original native dependency");
  write("late.cjs", "exports.value = 'original late import';");
  write("native.so", "original native bytes");
  write(
    "index.cjs",
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
  const create = () =>
    withPluginSourceCaptureDirectory(captures, () =>
      newInstance("recovery-fixture", {
        origin: "global",
        source: entry,
        rootDir: root,
        standalone,
      }),
    );
  return { root, entry, captures, instance: create(), create };
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
    const { root, entry, captures, instance, create } = fixture(standalone, nativePackageMap);
    const oldModule = instance.loadModule(entry) as FixtureModule;
    expect([oldModule.next(), oldModule.next()]).toEqual([1, 2]);
    expect(oldModule.native()).toBe("original native bytes");
    const nativeIdentity = fs.statSync(oldModule.nativePath);
    const dependencyIdentity = fs.statSync(oldModule.nativeDependencyPath());
    if (denyFileSymlinks) {
      const warm = create();
      const warmModule = warm.loadModule(entry) as FixtureModule;
      expect(warmModule.native()).toBe("original native bytes");
      expectIdentity(warmModule.nativePath, nativeIdentity);
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
    const recovery = capture(instance, captures);
    fs.writeFileSync(entry, "throw new Error('replacement code must not run during recovery');");
    await instance.dispose();
    fs.rmSync(root, { recursive: true });

    const restored = newInstance();
    withPluginSourceCaptureDirectory(captures, () => recovery.bind(restored));
    recovery.dispose();
    const restoredModule = restored.loadModule(entry) as FixtureModule;
    expect(restoredModule.next()).toBe(1);
    expect(restoredModule.dependency()).toBe("original dependency");
    expect(restoredModule.late()).toBe("original late import");
    expect(restoredModule.native()).toBe("original native bytes");
    expectIdentity(restoredModule.nativePath, nativeIdentity);
    expect(fs.readFileSync(restoredModule.nativeDependencyPath(), "utf8")).toBe(
      "original native dependency",
    );
    expectIdentity(restoredModule.nativeDependencyPath(), dependencyIdentity);
    expect(() => oldModule.next()).toThrow();

    // Recovery remains recoverable itself after another failed update.
    const again = capture(restored, captures);
    await restored.dispose();
    const final = newInstance();
    withPluginSourceCaptureDirectory(captures, () => again.bind(final));
    const finalModule = final.loadModule(entry) as FixtureModule;
    expect(finalModule.next()).toBe(1);
    expect(finalModule.late()).toBe("original late import");
    expect(finalModule.native()).toBe("original native bytes");
    expectIdentity(finalModule.nativePath, nativeIdentity);
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
  const recovery = capture(instance, captures);
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
  const recovery = capture(instance, captures);
  expect(() => instance.loadModule(entry)).toThrow(/reloaded or disabled/);
  const disposing = instance.dispose();
  expect(() => instance.captureModuleLoaderRecovery()).toThrow(/reloaded or disabled/);
  await disposing;
  fs.rmSync(root, { recursive: true });
  const restored = newInstance(instance.pluginId);
  recovery.bind(restored);
  recovery.dispose();
  expect((restored.loadModule(entry) as FixtureModule).dependency()).toBe("original dependency");
  expect((restored.loadModule(entry) as FixtureModule).late()).toBe("original late import");
});

it("shares bundled TypeScript code without captures and warns when edited code needs a restart", () => {
  const root = temp.make("bundled-source-identity-");
  const captures = temp.make("bundled-source-captures-");
  const entry = path.join(root, "index.ts");
  const writeEntry = (value: number) =>
    fs.writeFileSync(
      entry,
      `import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
       export const value: number = ${value};
       export const schema = emptyPluginConfigSchema().jsonSchema;`,
    );
  const load = () => {
    const { instance, value } = withPluginSourceCaptureDirectory(captures, () => {
      const created = newInstance("bundled-source", {
        origin: "bundled",
        source: entry,
        rootDir: root,
      });
      return { instance: created, value: created.loadModule(entry) };
    });
    expect(instance.sourceDigest).toBeUndefined();
    expect(fs.readdirSync(captures)).toEqual([]);
    expect(value).toMatchObject({ value: 1, schema: { type: "object" } });
    return instance;
  };

  writeEntry(1);
  expect(getSharedPluginCodeReloadWarning(load())).toBeUndefined();
  resetPluginCache();
  writeEntry(2);
  expect(getSharedPluginCodeReloadWarning(load())).toBe(
    "Bundled plugin code remains loaded. Restart the Gateway to load edited code.",
  );
});

it.each(["cjs", "mjs"])(
  "reuses bundled %s code while giving recovery fresh callback authority",
  async (extension) => {
    const root = temp.make("bundled-recovery-identity-");
    const entry = path.join(root, `index.${extension}`);
    fs.writeFileSync(
      entry,
      `let registrations = 0;
       ${extension === "mjs" ? "export const register =" : "exports.register ="} () => {
         const registration = ++registrations;
         return () => registration;
       };`,
    );
    type BundledModule = { register(): () => number };
    const previous = newInstance("bundled-recovery", {
      origin: "bundled",
      source: entry,
      rootDir: root,
    });
    const oldCallback = (previous.loadModule(entry) as BundledModule).register();
    expect(oldCallback()).toBe(1);
    expect(getSharedPluginCodeReloadWarning(previous)).toBeUndefined();
    const recovery = previous.captureModuleLoaderRecovery();
    await previous.dispose();
    fs.rmSync(root, { recursive: true });

    const restored = newInstance(previous.pluginId);
    recovery.bind(restored);
    recovery.dispose();
    const restoredCallback = (restored.loadModule(entry) as BundledModule).register();
    expect(restoredCallback()).toBe(2);
    expect(getSharedPluginCodeReloadWarning(restored)).toBeUndefined();
    expect(oldCallback).toThrow(/reloaded or disabled/);
    expect(restoredCallback()).toBe(2);

    const secondRecovery = restored.captureModuleLoaderRecovery();
    await restored.dispose();
    const final = newInstance(previous.pluginId);
    secondRecovery.bind(final);
    secondRecovery.dispose();
    expect((final.loadModule(entry) as BundledModule).register()()).toBe(3);
    expect(restoredCallback).toThrow(/reloaded or disabled/);
  },
);

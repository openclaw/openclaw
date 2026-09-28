import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import {
  capturePluginNativeNamespace,
  finishPluginNativeNamespace,
  pluginNativeNamespaceDirectory,
  pluginNativeNamespaceIsCurrent,
} from "./plugin-native-namespace.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("keeps ordinary dependency manifests safe to read through native capture and retained reuse", () => {
  const root = temp.make("native-package-manifests-");
  const source = path.join(root, "installed");
  const dependency = path.join(source, "node_modules", "companion");
  fs.mkdirSync(dependency, { recursive: true });
  const manifests = {
    "package.json": JSON.stringify({
      name: "native-fixture",
      version: "1.0.0",
      dependencies: { companion: "1.0.0" },
    }),
    "node_modules/companion/package.json": JSON.stringify({
      name: "companion",
      version: "1.0.0",
    }),
  };
  for (const [relative, bytes] of Object.entries(manifests)) {
    fs.writeFileSync(path.join(source, relative), bytes);
  }
  const native = path.join(source, "fixture.node");
  fs.writeFileSync(native, "synthetic native bytes");
  const first = capturePluginNativeNamespace({
    sourceDirectory: source,
    boundary: source,
    capturedRoot: path.join(root, "first"),
    managed: true,
  }).fact;
  finishPluginNativeNamespace(first);
  const verify = (fact: typeof first) => {
    const captured = pluginNativeNamespaceDirectory(fact);
    for (const [relative, bytes] of Object.entries(manifests)) {
      const installedFile = path.join(source, relative);
      const capturedFile = path.join(captured, relative);
      for (const filename of [installedFile, capturedFile]) {
        expect(
          readRootJsonObjectSync({
            rootDir: path.dirname(filename),
            relativePath: "package.json",
            boundaryLabel: "installed plugin package directory",
          }).ok,
        ).toBe(true);
        expect(fs.readFileSync(filename, "utf8")).toBe(bytes);
        expect(fs.statSync(filename).nlink).toBe(1);
      }
      const installedStat = fs.statSync(installedFile);
      const capturedStat = fs.statSync(capturedFile);
      expect([capturedStat.dev, capturedStat.ino]).not.toEqual([
        installedStat.dev,
        installedStat.ino,
      ]);
    }
    const installedNative = fs.statSync(native);
    expect(fs.statSync(path.join(captured, "fixture.node"))).toMatchObject({
      dev: installedNative.dev,
      ino: installedNative.ino,
    });
    expect(pluginNativeNamespaceIsCurrent(fact, source)).toBe(true);
  };
  verify(first);
  const retained = capturePluginNativeNamespace({
    sourceDirectory: source,
    boundary: source,
    capturedRoot: path.join(root, "retained"),
    managed: true,
    previous: first,
  }).fact;
  verify(first);
  verify(retained);
});

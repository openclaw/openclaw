import Module, { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginSourceCapture,
  findPluginCapturedPackage,
  withPluginSourceCaptureDirectory,
  type PluginPackageCapture,
} from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.each(["dispose", "disposeAsync"] as const)(
  "%s reclaims canonical path aliases without evicting another capture",
  async (method) => {
    const capture = withPluginSourceCaptureDirectory(temp.make("plugin-cache-owner-"), () =>
      createPluginSourceCapture(),
    );
    const filename = path.join(capture.directory, "module.cjs");
    const owned = new Set([
      filename,
      filename.replaceAll("\\", "/"),
      pathToFileURL(filename).href,
      `${path.dirname(capture.directory)}${path.sep}.${path.sep}${path.basename(capture.directory)}${path.sep}module.cjs`,
      ...(process.platform === "win32" ? [filename.toUpperCase()] : []),
    ]);
    const sibling = `${capture.directory}-sibling${path.sep}module.cjs`;
    const preserved = [sibling, pathToFileURL(sibling).href];
    const cache = createRequire(import.meta.url).cache;
    const record = new Module(filename);
    for (const id of [...owned, ...preserved]) {
      cache[id] = record;
    }
    const pending = capture[method]();
    try {
      expect([...owned].filter((id) => cache[id] !== undefined)).toEqual([]);
      expect(preserved.every((id) => cache[id] === record)).toBe(true);
    } finally {
      await pending;
      for (const id of [...owned, ...preserved]) {
        delete cache[id];
      }
    }
  },
);

function capturedPackage(root: string, links: string[] = []): PluginPackageCapture {
  return {
    capturedRoot: path.resolve(root),
    sourceRoot: path.resolve(root),
    links: new Set(links.map((link) => path.resolve(link))),
    state: "body",
    materialize() {},
    captureTarget() {},
  };
}

describe("captured package lookup", () => {
  const directory = path.resolve("fixture");
  const packagesOf = (...owners: PluginPackageCapture[]) =>
    new Map(owners.map((owner) => [owner.capturedRoot, owner]));
  const lookup = (packages: ReadonlyMap<string, PluginPackageCapture>, filename: string) =>
    findPluginCapturedPackage(packages, filename, directory);
  it.each([
    ["", true],
    ["/lib/module.js", true],
    ["/./lib/../module.js", true],
    ["//lib///module.js", true],
    ["/../outside/module.js", false],
    ["-other/module.js", false],
    ["/node_modules", false],
    ["/lib/node_modules/dependency/module.js", false],
    ["/node_modules-other/module.js", true],
    ["/lib/node_modules.js", true],
    ["/ümlaut/module.js", true],
  ] as const)("preserves package containment for '%s'", (suffix, matches) => {
    const owner = capturedPackage("fixture/owner");
    const packages = packagesOf(owner);
    const filename = owner.capturedRoot + suffix.replaceAll("/", path.sep);
    expect(lookup(packages, filename)).toEqual(
      matches ? { owner, root: owner.capturedRoot } : undefined,
    );
  });

  it("keeps package order and resolves dependency links instead of the enclosing package", () => {
    const parent = capturedPackage("fixture/owner");
    const nested = capturedPackage(path.join(parent.capturedRoot, "lib"));
    const link = path.join(parent.capturedRoot, "node_modules", "@scope", "dependency");
    const dependency = capturedPackage("fixture/dependency", [link]);
    const packages = packagesOf(parent, nested, dependency);

    expect(lookup(packages, path.join(nested.capturedRoot, "module.js"))).toEqual({
      owner: parent,
      root: parent.capturedRoot,
    });
    expect(lookup(packages, path.join(link, "module.js"))).toEqual({
      owner: dependency,
      root: link,
    });
  });

  it("observes link additions, removals, and package removal on the next lookup", () => {
    const owner = capturedPackage("fixture/owner");
    const link = path.resolve("fixture/late-link");
    const filename = path.join(link, "module.js");
    const packages = packagesOf(owner);
    expect(lookup(packages, filename)).toBeUndefined();
    owner.links.add(link);
    expect(lookup(packages, filename)).toEqual({ owner, root: link });
    owner.links.delete(link);
    expect(lookup(packages, filename)).toBeUndefined();
    owner.links.add(link);
    packages.delete(owner.capturedRoot);
    expect(lookup(packages, filename)).toBeUndefined();
  });
});

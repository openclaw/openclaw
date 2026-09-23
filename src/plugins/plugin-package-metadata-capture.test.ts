import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findPluginCapturedPackage,
  type PluginPackageCapture,
} from "./plugin-package-metadata-capture.js";

function capturedPackage(root: string, links: string[] = []): PluginPackageCapture {
  return {
    destination: path.resolve(root),
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
  it.each([
    { suffix: "", matches: true },
    { suffix: "/lib/module.js", matches: true },
    { suffix: "/./lib/../module.js", matches: true },
    { suffix: "//lib///module.js", matches: true },
    { suffix: "/../outside/module.js", matches: false },
    { suffix: "-other/module.js", matches: false },
    { suffix: "/node_modules", matches: false },
    { suffix: "/lib/node_modules/dependency/module.js", matches: false },
    { suffix: "/node_modules-other/module.js", matches: true },
    { suffix: "/lib/node_modules.js", matches: true },
    { suffix: "/ümlaut/module.js", matches: true },
  ])("preserves package containment for '$suffix'", ({ suffix, matches }) => {
    const owner = capturedPackage("fixture/owner");
    const packages = new Map([[owner.capturedRoot, owner]]);
    const filename = owner.capturedRoot + suffix.replaceAll("/", path.sep);
    expect(findPluginCapturedPackage(packages, filename, directory)).toEqual(
      matches ? { owner, root: owner.capturedRoot } : undefined,
    );
  });

  it("keeps package order and resolves dependency links instead of the enclosing package", () => {
    const parent = capturedPackage("fixture/owner");
    const nested = capturedPackage(path.join(parent.capturedRoot, "lib"));
    const link = path.join(parent.capturedRoot, "node_modules", "@scope", "dependency");
    const dependency = capturedPackage("fixture/dependency", [link]);
    const packages = new Map([
      [parent.capturedRoot, parent],
      [nested.capturedRoot, nested],
      [dependency.capturedRoot, dependency],
    ]);

    expect(
      findPluginCapturedPackage(packages, path.join(nested.capturedRoot, "module.js"), directory),
    ).toEqual({
      owner: parent,
      root: parent.capturedRoot,
    });
    expect(findPluginCapturedPackage(packages, path.join(link, "module.js"), directory)).toEqual({
      owner: dependency,
      root: link,
    });
  });

  it("observes link additions, removals, and package removal on the next lookup", () => {
    const owner = capturedPackage("fixture/owner");
    const link = path.resolve("fixture/late-link");
    const filename = path.join(link, "module.js");
    const packages = new Map([[owner.capturedRoot, owner]]);
    expect(findPluginCapturedPackage(packages, filename, directory)).toBeUndefined();
    owner.links.add(link);
    expect(findPluginCapturedPackage(packages, filename, directory)).toEqual({ owner, root: link });
    owner.links.delete(link);
    expect(findPluginCapturedPackage(packages, filename, directory)).toBeUndefined();
    owner.links.add(link);
    packages.delete(owner.capturedRoot);
    expect(findPluginCapturedPackage(packages, filename, directory)).toBeUndefined();
  });
});

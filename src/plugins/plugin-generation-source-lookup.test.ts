import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginGenerationSourceLookup } from "./plugin-generation-source-lookup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin generation source lookup", () => {
  it("accepts a captured source beneath a physical Windows root alias", () => {
    const parent = fs.realpathSync(tempDirs.make("plugin-generation-source-alias-"));
    const root = path.join(parent, "canonical-root");
    const alias = path.join(parent, "root-alias");
    const source = path.join(root, "index.js");
    fs.mkdirSync(root);
    fs.writeFileSync(source, "export default {};\n");
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const assertModuleAvailable = vi.fn();

    const aliasedSource = path.join(alias, "index.js");
    const lookup = createPluginGenerationSourceLookup({
      rootDir: alias,
      sourceRoot: alias,
      capturedRoot: alias,
      boundaryRoot: alias,
      capturedPaths: new Map([[aliasedSource, source]]),
      hardlinkedSources: new Set(),
      assertModuleAvailable,
    });

    expect(lookup.hasSource(source)).toBe(true);
    expect(lookup.resolve(source)).toBe(source);
    expect(assertModuleAvailable).toHaveBeenCalledWith(source);
  });

  it("keeps canonical source keys when the configured alias has a different depth", () => {
    const parent = fs.realpathSync(tempDirs.make("plugin-generation-source-depth-"));
    const sourceRoot = path.join(parent, "packages", "demo");
    const rootDir = path.join(parent, "plugin-link");
    const source = path.join(sourceRoot, "setup.js");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(source, "export default {};\n");
    fs.symlinkSync(sourceRoot, rootDir, process.platform === "win32" ? "junction" : "dir");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const lookup = createPluginGenerationSourceLookup({
      rootDir,
      sourceRoot,
      capturedRoot: sourceRoot,
      boundaryRoot: sourceRoot,
      capturedPaths: new Map([[source, source]]),
      hardlinkedSources: new Set(),
      assertModuleAvailable: vi.fn(),
    });

    expect(lookup.hasSource(source)).toBe(true);
    expect(lookup.resolve(source)).toBe(source);
  });

  it("relocates absolute dependency junctions into the captured generation", () => {
    const boundaryRoot = fs.realpathSync(tempDirs.make("plugin-generation-junctions-"));
    const pluginRoot = path.join(boundaryRoot, "plugin");
    const dependencyRoot = path.join(boundaryRoot, "shared");
    const source = path.join(pluginRoot, "index.js");
    const dependencyLink = path.join(pluginRoot, "node_modules", "shared");
    fs.mkdirSync(path.dirname(dependencyLink), { recursive: true });
    fs.mkdirSync(dependencyRoot);
    fs.writeFileSync(source, "export default {};\n");
    fs.writeFileSync(path.join(dependencyRoot, "resource.txt"), "captured");
    fs.symlinkSync(dependencyRoot, dependencyLink, "junction");

    const lookup = createPluginGenerationSourceLookup({
      rootDir: pluginRoot,
      sourceRoot: pluginRoot,
      capturedRoot: pluginRoot,
      boundaryRoot,
      capturedPaths: new Map([[source, source]]),
      hardlinkedSources: new Set(),
      assertModuleAvailable: vi.fn(),
    });
    const recovery = lookup.captureRecoverySource();
    try {
      const capturedLink = path.join(recovery.rootDir, "node_modules", "shared");
      expect(path.isAbsolute(fs.readlinkSync(capturedLink))).toBe(false);
      expect(fs.realpathSync(capturedLink)).toBe(
        fs.realpathSync(path.join(path.dirname(recovery.rootDir), "shared")),
      );
      expect(fs.readFileSync(path.join(capturedLink, "resource.txt"), "utf8")).toBe("captured");
    } finally {
      recovery.dispose();
    }
  });
});

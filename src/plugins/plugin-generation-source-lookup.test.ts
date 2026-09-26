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

  it("resolves a canonical spelling of a captured file beneath an aliased capture root", () => {
    // Windows safe opens report C:\Users\Sovereign\... while the capture was
    // created beneath the 8.3 spelling C:\Users\SOVERE~1\... (#152872).
    const parent = fs.realpathSync(tempDirs.make("plugin-generation-capture-alias-"));
    const canonicalBoundary = path.join(parent, "capture");
    const aliasBoundary = path.join(parent, "CAPTUR~1");
    fs.mkdirSync(path.join(canonicalBoundary, "package-0", "dist"), { recursive: true });
    fs.symlinkSync(
      canonicalBoundary,
      aliasBoundary,
      process.platform === "win32" ? "junction" : "dir",
    );
    const capturedRoot = path.join(aliasBoundary, "package-0");
    const capturedCompanion = path.join(capturedRoot, "dist", "channel-plugin-api.js");
    fs.writeFileSync(capturedCompanion, "export default {};\n");
    const canonicalCompanion = path.join(
      canonicalBoundary,
      "package-0",
      "dist",
      "channel-plugin-api.js",
    );
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const assertModuleAvailable = vi.fn();

    const lookup = createPluginGenerationSourceLookup({
      rootDir: path.join(parent, "installed"),
      sourceRoot: path.join(parent, "installed"),
      capturedRoot,
      boundaryRoot: aliasBoundary,
      capturedPaths: new Map([[capturedCompanion, capturedCompanion]]),
      hardlinkedSources: new Set(),
      assertModuleAvailable,
    });

    expect(lookup.hasSource(canonicalCompanion)).toBe(true);
    expect(lookup.resolve(canonicalCompanion)).toBe(capturedCompanion);
    expect(assertModuleAvailable).toHaveBeenCalledWith(capturedCompanion);
  });

  it("does not rebase paths outside the capture root or on other platforms", () => {
    const parent = fs.realpathSync(tempDirs.make("plugin-generation-capture-outside-"));
    const canonicalBoundary = path.join(parent, "capture");
    const aliasBoundary = path.join(parent, "CAPTUR~1");
    const outside = path.join(parent, "outside", "channel-plugin-api.js");
    fs.mkdirSync(path.join(canonicalBoundary, "package-0"), { recursive: true });
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "export default {};\n");
    fs.symlinkSync(
      canonicalBoundary,
      aliasBoundary,
      process.platform === "win32" ? "junction" : "dir",
    );
    const capturedRoot = path.join(aliasBoundary, "package-0");
    const capturedCompanion = path.join(capturedRoot, "channel-plugin-api.js");
    fs.writeFileSync(capturedCompanion, "export default {};\n");
    const createLookup = () =>
      createPluginGenerationSourceLookup({
        rootDir: path.join(parent, "installed"),
        sourceRoot: path.join(parent, "installed"),
        capturedRoot,
        boundaryRoot: aliasBoundary,
        capturedPaths: new Map([[capturedCompanion, capturedCompanion]]),
        hardlinkedSources: new Set(),
        assertModuleAvailable: vi.fn(),
      });
    const canonicalCompanion = path.join(canonicalBoundary, "package-0", "channel-plugin-api.js");

    if (process.platform !== "win32") {
      expect(createLookup().hasSource(canonicalCompanion)).toBe(false);
    }
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(createLookup().hasSource(outside)).toBe(false);
  });
});

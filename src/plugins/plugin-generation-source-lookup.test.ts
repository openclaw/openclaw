import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginGenerationSourceLookup,
  restorePluginRecoverySourceResolver,
  snapshotPluginRecoverySourceResolver,
} from "./plugin-generation-source-lookup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin generation source lookup", () => {
  it("recovery includes later graph additions and relocates dependency links", async () => {
    const parent = fs.realpathSync(tempDirs.make("plugin-generation-recovery-"));
    const sourceRoot = path.join(parent, "installed");
    const boundaryRoot = path.join(parent, "captured");
    const capturedRoot = path.join(boundaryRoot, "plugin");
    const dependency = path.join(boundaryRoot, "dependency");
    fs.mkdirSync(capturedRoot, { recursive: true });
    fs.mkdirSync(dependency);
    fs.writeFileSync(path.join(capturedRoot, "index.js"), "export default 1;\n");
    fs.symlinkSync(
      dependency,
      path.join(capturedRoot, "dependency"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const capturedPaths = new Map([
      [path.join(sourceRoot, "index.js"), path.join(capturedRoot, "index.js")],
    ]);
    const capturedDirectories = new Set([capturedRoot]);
    const lookup = createPluginGenerationSourceLookup({
      rootDir: sourceRoot,
      sourceRoot,
      capturedRoot,
      boundaryRoot,
      capturedPaths,
      capturedDirectories,
      hardlinkedSources: new Set(),
      assertModuleAvailable: () => {},
    });
    // A lazy import extends the existing owner after the lookup was created.
    const laterSource = path.join(sourceRoot, "later.js");
    fs.writeFileSync(path.join(dependency, "later.js"), "export default 2;\n");
    capturedPaths.set(laterSource, path.join(dependency, "later.js"));
    capturedDirectories.add(dependency);
    const recovery = lookup.captureRecoverySource();
    try {
      fs.rmSync(boundaryRoot, { recursive: true, force: true });
      expect(fs.readFileSync(recovery.resolve(laterSource), "utf8")).toBe("export default 2;\n");
      expect(recovery.directories.has(path.dirname(recovery.resolve(laterSource)))).toBe(true);
      const fork = recovery.fork();
      try {
        await recovery.disposeAsync();
        expect(fs.readFileSync(path.join(fork.rootDir, "dependency", "later.js"), "utf8")).toBe(
          "export default 2;\n",
        );
        expect(fs.readFileSync(fork.resolve(path.join(sourceRoot, "index.js")), "utf8")).toBe(
          "export default 1;\n",
        );
      } finally {
        await fork.disposeAsync();
      }
    } finally {
      await recovery.disposeAsync();
    }
  });

  it("reuses isolated recovery facts for transport", () => {
    const root = path.resolve("fixture-source");
    const source = path.join(root, "index.js");
    const captured = path.resolve("fixture-capture", "index.js");
    const sources = new Map([[source, captured]]);
    const resolve = restorePluginRecoverySourceResolver({
      rootDir: root,
      sourceRoot: root,
      sources,
    });
    sources.set(source, path.resolve("replacement.js"));
    sources.set(path.join(root, "later.js"), captured);

    const snapshot = snapshotPluginRecoverySourceResolver(resolve)!;
    expect(snapshotPluginRecoverySourceResolver(resolve)).toBe(snapshot);
    expect(snapshot.sources).not.toBe(sources);
    expect(resolve(source)).toBe(captured);
    expect(() => resolve(path.join(root, "later.js"))).toThrow(
      "outside its captured source package",
    );
  });

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
      capturedDirectories: new Set(),
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
      capturedDirectories: new Set(),
      hardlinkedSources: new Set(),
      assertModuleAvailable: vi.fn(),
    });

    expect(lookup.hasSource(source)).toBe(true);
    expect(lookup.resolve(source)).toBe(source);
  });
});

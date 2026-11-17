import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import {
  createPluginGenerationSourceLookup,
  restorePluginRecoverySourceResolver,
  snapshotPluginRecoverySourceResolver,
} from "./plugin-generation-source-lookup.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin generation source lookup", () => {
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
});

it("copies recovery source and metadata without foreground synchronous filesystem work", async () => {
  const parent = tempDirs.make("plugin-recovery-copy-");
  const root = path.join(parent, "source");
  const output = path.join(parent, "recovery");
  fs.mkdirSync(root);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(root, "index.js"), "export default 42;\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const filename = path.join(root, "index.js");
  const lookup = createPluginGenerationSourceLookup({
    rootDir: root,
    sourceRoot: root,
    capturedRoot: root,
    boundaryRoot: root,
    capturedPaths: new Map([[filename, filename]]),
    hardlinkedSources: new Set(),
    assertModuleAvailable: () => {},
  });
  try {
    const { recovery, calls } = await (async () => {
      using observed = observeMainThreadFs();
      const capturedRecovery = await withPluginSourceCaptureDirectory(output, () =>
        lookup.captureRecoverySourceAsync(),
      );
      return {
        recovery: capturedRecovery,
        calls: observed
          .stacks()
          .filter(({ stack }) =>
            /plugin-(?:recovery-source-copy|source-capture-directory|package-metadata-capture)/.test(
              stack,
            ),
          ),
      };
    })();
    try {
      expect(calls).toEqual([]);
      expect(fs.readFileSync(recovery.resolve(filename), "utf8")).toBe("export default 42;\n");
      expect(
        fs.readFileSync(path.join(recovery.sourceCapture.directory, "package.json"), "utf8"),
      ).toBe('{"type":"module"}');
    } finally {
      await recovery.disposeAsync();
    }
    expect(fs.readdirSync(output)).toEqual([]);
  } finally {
    await closeDefaultRetainedNativeWorkerSource();
  }
});

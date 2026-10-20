import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginGenerationSourceLookup } from "./plugin-generation-source-lookup.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

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
});

it.each(["absolute", "relative"] as const)(
  "keeps %s captured dependency links inside recovery after the original capture retires",
  (kind) => {
    const parent = fs.realpathSync(tempDirs.make("plugin-recovery-dependency-"));
    const boundary = path.join(parent, "capture");
    const plugin = path.join(boundary, "plugin");
    const dependency = path.join(boundary, "dependency");
    fs.mkdirSync(path.join(plugin, "node_modules"), { recursive: true });
    fs.mkdirSync(dependency);
    const entry = path.join(plugin, "index.cjs");
    fs.writeFileSync(entry, "module.exports = require('dependency');");
    fs.writeFileSync(path.join(dependency, "index.js"), "module.exports = 42;");
    const link = path.join(plugin, "node_modules", "dependency");
    fs.symlinkSync(
      kind === "absolute" ? dependency : path.relative(path.dirname(link), dependency),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    const lookup = createPluginGenerationSourceLookup({
      rootDir: plugin,
      sourceRoot: plugin,
      capturedRoot: plugin,
      boundaryRoot: boundary,
      capturedPaths: new Map([[entry, entry]]),
      hardlinkedSources: new Set(),
      assertModuleAvailable: (filename) => fs.accessSync(filename),
    });
    withPluginSourceCaptureStorage({ stateDir: parent, placement: "temporary" }, () => {
      const recovery = lookup.captureRecoverySource();
      const fork = recovery.fork();
      try {
        recovery.dispose();
        fs.rmSync(boundary, { recursive: true });
        const recoveredEntry = fork.resolve(entry);
        const recoveredRequire = createRequire(recoveredEntry);
        expect(recoveredRequire("dependency")).toBe(42);
        expect(fs.realpathSync(path.join(fork.rootDir, "node_modules", "dependency"))).toBe(
          path.join(fork.sourceCapture.directory, "dependency"),
        );
      } finally {
        fork.dispose();
        recovery.dispose();
      }
    });
  },
);

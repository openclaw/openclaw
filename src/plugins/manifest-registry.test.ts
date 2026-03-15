import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  clearPluginManifestRegistryCache,
  loadPluginManifestRegistry,
} from "./manifest-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(dir, 0o755);
}

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  chmodSafeDir(dir);
}

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-registry", tempDirs);
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf-8");
}

function createPluginCandidate(params: {
  idHint: string;
  rootDir: string;
  sourceName?: string;
  origin: "bundled" | "global" | "workspace" | "config";
}): PluginCandidate {
  return {
    idHint: params.idHint,
    source: path.join(params.rootDir, params.sourceName ?? "index.ts"),
    rootDir: params.rootDir,
    origin: params.origin,
  };
}

function loadRegistry(candidates: PluginCandidate[]) {
  return loadPluginManifestRegistry({
    candidates,
    cache: false,
  });
}

function countDuplicateWarnings(registry: ReturnType<typeof loadPluginManifestRegistry>): number {
  return registry.diagnostics.filter(
    (diagnostic) =>
      diagnostic.level === "warn" && diagnostic.message?.includes("duplicate plugin id"),
  ).length;
}

function prepareLinkedManifestFixture(params: { id: string; mode: "symlink" | "hardlink" }): {
  rootDir: string;
  linked: boolean;
} {
  const rootDir = makeTempDir();
  const outsideDir = makeTempDir();
  const outsideManifest = path.join(outsideDir, "openclaw.plugin.json");
  const linkedManifest = path.join(rootDir, "openclaw.plugin.json");
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default function () {}", "utf-8");
  fs.writeFileSync(
    outsideManifest,
    JSON.stringify({ id: params.id, configSchema: { type: "object" } }),
    "utf-8",
  );

  try {
    if (params.mode === "symlink") {
      fs.symlinkSync(outsideManifest, linkedManifest);
    } else {
      fs.linkSync(outsideManifest, linkedManifest);
    }
    return { rootDir, linked: true };
  } catch (err) {
    if (params.mode === "symlink") {
      return { rootDir, linked: false };
    }
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      return { rootDir, linked: false };
    }
    throw err;
  }
}

function loadSingleCandidateRegistry(params: {
  idHint: string;
  rootDir: string;
  origin: "bundled" | "global" | "workspace" | "config";
}) {
  return loadRegistry([
    createPluginCandidate({
      idHint: params.idHint,
      rootDir: params.rootDir,
      origin: params.origin,
    }),
  ]);
}

function hasUnsafeManifestDiagnostic(registry: ReturnType<typeof loadPluginManifestRegistry>) {
  return registry.diagnostics.some((diag) => diag.message.includes("unsafe plugin manifest path"));
}

function expectUnsafeWorkspaceManifestRejected(params: {
  id: string;
  mode: "symlink" | "hardlink";
}) {
  const fixture = prepareLinkedManifestFixture({ id: params.id, mode: params.mode });
  if (!fixture.linked) {
    return;
  }
  const registry = loadSingleCandidateRegistry({
    idHint: params.id,
    rootDir: fixture.rootDir,
    origin: "workspace",
  });
  expect(registry.plugins).toHaveLength(0);
  expect(hasUnsafeManifestDiagnostic(registry)).toBe(true);
}

afterEach(() => {
  clearPluginManifestRegistryCache();
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifestRegistry", () => {
  it("emits duplicate warning for truly distinct plugins with same id", () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const manifest = { id: "test-plugin", configSchema: { type: "object" } };
    writeManifest(dirA, manifest);
    writeManifest(dirB, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "test-plugin",
        rootDir: dirA,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "test-plugin",
        rootDir: dirB,
        origin: "global",
      }),
    ];

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(1);
  });

  it("reports explicit installed globals as the effective duplicate winner", () => {
    const bundledDir = makeTempDir();
    const globalDir = makeTempDir();
    const manifest = { id: "zalouser", configSchema: { type: "object" } };
    writeManifest(bundledDir, manifest);
    writeManifest(globalDir, manifest);

    const registry = loadPluginManifestRegistry({
      cache: false,
      config: {
        plugins: {
          installs: {
            zalouser: {
              source: "npm",
              installPath: globalDir,
            },
          },
        },
      },
      candidates: [
        createPluginCandidate({
          idHint: "zalouser",
          rootDir: bundledDir,
          origin: "bundled",
        }),
        createPluginCandidate({
          idHint: "zalouser",
          rootDir: globalDir,
          origin: "global",
        }),
      ],
    });

    expect(
      registry.diagnostics.some((diag) =>
        diag.message.includes("bundled plugin will be overridden by global plugin"),
      ),
    ).toBe(true);
  });

  it("reports bundled plugins as the duplicate winner for auto-discovered globals", () => {
    const bundledDir = makeTempDir();
    const globalDir = makeTempDir();
    const manifest = { id: "feishu", configSchema: { type: "object" } };
    writeManifest(bundledDir, manifest);
    writeManifest(globalDir, manifest);

    const registry = loadPluginManifestRegistry({
      cache: false,
      candidates: [
        createPluginCandidate({
          idHint: "feishu",
          rootDir: bundledDir,
          origin: "bundled",
        }),
        createPluginCandidate({
          idHint: "feishu",
          rootDir: globalDir,
          origin: "global",
        }),
      ],
    });

    expect(
      registry.diagnostics.some((diag) =>
        diag.message.includes("global plugin will be overridden by bundled plugin"),
      ),
    ).toBe(true);
  });

  it("suppresses duplicate warning when candidates share the same physical directory via symlink", () => {
    const realDir = makeTempDir();
    const manifest = { id: "feishu", configSchema: { type: "object" } };
    writeManifest(realDir, manifest);

    // Create a symlink pointing to the same directory
    const symlinkParent = makeTempDir();
    const symlinkPath = path.join(symlinkParent, "feishu-link");
    try {
      fs.symlinkSync(realDir, symlinkPath, "junction");
    } catch {
      // On systems where symlinks are not supported (e.g. restricted Windows),
      // skip this test gracefully.
      return;
    }

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "feishu",
        rootDir: realDir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "feishu",
        rootDir: symlinkPath,
        origin: "bundled",
      }),
    ];

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(0);
  });

  it("suppresses duplicate warning when candidates have identical rootDir paths", () => {
    const dir = makeTempDir();
    const manifest = { id: "same-path-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "same-path-plugin",
        rootDir: dir,
        sourceName: "a.ts",
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "same-path-plugin",
        rootDir: dir,
        sourceName: "b.ts",
        origin: "global",
      }),
    ];

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(0);
  });

  it("prefers higher-precedence origins for the same physical directory (config > workspace > global > bundled)", () => {
    const dir = makeTempDir();
    mkdirSafe(path.join(dir, "sub"));
    const manifest = { id: "precedence-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    // Use a different-but-equivalent path representation without requiring symlinks.
    const altDir = path.join(dir, "sub", "..");

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "precedence-plugin",
        rootDir: dir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "precedence-plugin",
        rootDir: altDir,
        origin: "config",
      }),
    ];

    const registry = loadRegistry(candidates);
    expect(countDuplicateWarnings(registry)).toBe(0);
    expect(registry.plugins.length).toBe(1);
    expect(registry.plugins[0]?.origin).toBe("config");
  });

  it("rejects manifest paths that escape plugin root via symlink", () => {
    expectUnsafeWorkspaceManifestRejected({ id: "unsafe-symlink", mode: "symlink" });
  });

  it("rejects manifest paths that escape plugin root via hardlink", () => {
    if (process.platform === "win32") {
      return;
    }
    expectUnsafeWorkspaceManifestRejected({ id: "unsafe-hardlink", mode: "hardlink" });
  });

  it("allows bundled manifest paths that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = prepareLinkedManifestFixture({ id: "bundled-hardlink", mode: "hardlink" });
    if (!fixture.linked) {
      return;
    }

    const registry = loadSingleCandidateRegistry({
      idHint: "bundled-hardlink",
      rootDir: fixture.rootDir,
      origin: "bundled",
    });
    expect(registry.plugins.some((entry) => entry.id === "bundled-hardlink")).toBe(true);
    expect(hasUnsafeManifestDiagnostic(registry)).toBe(false);
  });

  it("does not reuse cached bundled plugin roots across env changes", () => {
    const bundledA = makeTempDir();
    const bundledB = makeTempDir();
    const matrixA = path.join(bundledA, "matrix");
    const matrixB = path.join(bundledB, "matrix");
    mkdirSafe(matrixA);
    mkdirSafe(matrixB);
    writeManifest(matrixA, {
      id: "matrix",
      name: "Matrix A",
      configSchema: { type: "object" },
    });
    writeManifest(matrixB, {
      id: "matrix",
      name: "Matrix B",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(matrixA, "index.ts"), "export default {}", "utf-8");
    fs.writeFileSync(path.join(matrixB, "index.ts"), "export default {}", "utf-8");

    const first = loadPluginManifestRegistry({
      cache: true,
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledA,
      },
    });
    const second = loadPluginManifestRegistry({
      cache: true,
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledB,
      },
    });

    expect(
      fs.realpathSync(first.plugins.find((plugin) => plugin.id === "matrix")?.rootDir ?? ""),
    ).toBe(fs.realpathSync(matrixA));
    expect(
      fs.realpathSync(second.plugins.find((plugin) => plugin.id === "matrix")?.rootDir ?? ""),
    ).toBe(fs.realpathSync(matrixB));
  });

  it("does not reuse cached load-path manifests across env home changes", () => {
    const homeA = makeTempDir();
    const homeB = makeTempDir();
    const demoA = path.join(homeA, "plugins", "demo");
    const demoB = path.join(homeB, "plugins", "demo");
    mkdirSafe(demoA);
    mkdirSafe(demoB);
    writeManifest(demoA, {
      id: "demo",
      name: "Demo A",
      configSchema: { type: "object" },
    });
    writeManifest(demoB, {
      id: "demo",
      name: "Demo B",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(demoA, "index.ts"), "export default {}", "utf-8");
    fs.writeFileSync(path.join(demoB, "index.ts"), "export default {}", "utf-8");

    const config = {
      plugins: {
        load: {
          paths: ["~/plugins/demo"],
        },
      },
    };

    const first = loadPluginManifestRegistry({
      cache: true,
      config,
      env: {
        ...process.env,
        HOME: homeA,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: path.join(homeA, ".state"),
      },
    });
    const second = loadPluginManifestRegistry({
      cache: true,
      config,
      env: {
        ...process.env,
        HOME: homeB,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: path.join(homeB, ".state"),
      },
    });

    expect(
      fs.realpathSync(first.plugins.find((plugin) => plugin.id === "demo")?.rootDir ?? ""),
    ).toBe(fs.realpathSync(demoA));
    expect(
      fs.realpathSync(second.plugins.find((plugin) => plugin.id === "demo")?.rootDir ?? ""),
    ).toBe(fs.realpathSync(demoB));
  });

  it("suppresses duplicate warning when plugin id matches a declared channel (channel registration pattern)", () => {
    // This tests the fix for issue #45805:
    // A plugin with id="X" that declares channels=["X"] is the expected pattern
    // for channel plugins - the main plugin and its channel share the same id.
    // This should not trigger a duplicate warning.
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    // First plugin declares id="feishu" and channels=["feishu"]
    writeManifest(dirA, {
      id: "feishu",
      channels: ["feishu"],
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(dirA, "index.ts"), "export default {}", "utf-8");

    // Second plugin has the same id but from a different directory
    writeManifest(dirB, {
      id: "feishu",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(dirB, "index.ts"), "export default {}", "utf-8");

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "feishu",
        rootDir: dirA,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "feishu",
        rootDir: dirB,
        origin: "global",
      }),
    ];

    const registry = loadRegistry(candidates);
    // Should NOT emit a duplicate warning because the first plugin declares
    // channels=["feishu"], indicating this is a channel registration pattern.
    expect(countDuplicateWarnings(registry)).toBe(0);
  });

  it("still emits duplicate warning when channels do not match the plugin id", () => {
    // Ensure we still warn when the channel registration pattern does NOT apply
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    // First plugin declares id="alpha" and channels=["beta"] (different from id)
    writeManifest(dirA, {
      id: "alpha",
      channels: ["beta"],
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(dirA, "index.ts"), "export default {}", "utf-8");

    // Second plugin has the same id
    writeManifest(dirB, {
      id: "alpha",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(dirB, "index.ts"), "export default {}", "utf-8");

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "alpha",
        rootDir: dirA,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "alpha",
        rootDir: dirB,
        origin: "global",
      }),
    ];

    const registry = loadRegistry(candidates);
    // Should emit a duplicate warning because the channels array does NOT contain "alpha"
    expect(countDuplicateWarnings(registry)).toBe(1);
  });

  it("suppresses duplicate warning when candidates have identical source file path", () => {
    // This tests the fix for issue #45951:
    // Same source file discovered multiple times should not trigger duplicate warning,
    // even if rootDir representations differ.
    const dir = makeTempDir();
    const manifest = { id: "same-source-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "same-source-plugin",
        rootDir: dir,
        origin: "bundled",
      }),
      // Same source file, same rootDir - should be detected as duplicate and skipped
      createPluginCandidate({
        idHint: "same-source-plugin",
        rootDir: dir,
        origin: "global",
      }),
    ];

    const registry = loadRegistry(candidates);
    // Should NOT emit a duplicate warning because both point to the same source file
    expect(countDuplicateWarnings(registry)).toBe(0);
    // Should only have one plugin entry
    expect(registry.plugins.length).toBe(1);
  });

  it("suppresses duplicate warning when source paths are identical but rootDir differs", () => {
    // Edge case: same source file with different rootDir representations
    // (e.g., one with trailing slash, one without, or different case on Windows)
    const dir = makeTempDir();
    const manifest = { id: "path-variant-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    // Create two candidates with same source but different rootDir string representations
    // Note: On most systems, path.resolve normalizes these, but we want to be safe
    const sourcePath = path.join(dir, "index.ts");
    const candidates: PluginCandidate[] = [
      {
        idHint: "path-variant-plugin",
        source: sourcePath,
        rootDir: dir,
        origin: "bundled",
      },
      {
        idHint: "path-variant-plugin",
        source: sourcePath, // Same source
        rootDir: path.resolve(dir), // Different string representation but resolves to same
        origin: "global",
      },
    ];

    const registry = loadRegistry(candidates);
    // Should NOT emit a duplicate warning
    expect(countDuplicateWarnings(registry)).toBe(0);
  });
});

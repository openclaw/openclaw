import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  clearPluginManifestRegistryCache,
  loadPluginManifestRegistry,
} from "./manifest-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const previousUmask = process.umask(0o022);

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

afterAll(() => {
  process.umask(previousUmask);
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
});

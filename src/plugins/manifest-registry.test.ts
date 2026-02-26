import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-manifest-registry-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      break;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
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
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
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
    const rootDir = makeTempDir();
    const outsideDir = makeTempDir();
    const outsideManifest = path.join(outsideDir, "openclaw.plugin.json");
    const linkedManifest = path.join(rootDir, "openclaw.plugin.json");
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default function () {}", "utf-8");
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({ id: "unsafe-symlink", configSchema: { type: "object" } }),
      "utf-8",
    );
    try {
      fs.symlinkSync(outsideManifest, linkedManifest);
    } catch {
      return;
    }

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "unsafe-symlink",
        rootDir,
        origin: "workspace",
      }),
    ]);
    expect(registry.plugins).toHaveLength(0);
    expect(
      registry.diagnostics.some((diag) => diag.message.includes("unsafe plugin manifest path")),
    ).toBe(true);
  });

  it("rejects manifest paths that escape plugin root via hardlink", () => {
    if (process.platform === "win32") {
      return;
    }
    const rootDir = makeTempDir();
    const outsideDir = makeTempDir();
    const outsideManifest = path.join(outsideDir, "openclaw.plugin.json");
    const linkedManifest = path.join(rootDir, "openclaw.plugin.json");
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default function () {}", "utf-8");
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({ id: "unsafe-hardlink", configSchema: { type: "object" } }),
      "utf-8",
    );
    try {
      fs.linkSync(outsideManifest, linkedManifest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "unsafe-hardlink",
        rootDir,
        origin: "workspace",
      }),
    ]);
    expect(registry.plugins).toHaveLength(0);
    expect(
      registry.diagnostics.some((diag) => diag.message.includes("unsafe plugin manifest path")),
    ).toBe(true);
  });
});

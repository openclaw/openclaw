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
      {
        idHint: "test-plugin",
        source: path.join(dirA, "index.ts"),
        rootDir: dirA,
        origin: "bundled",
      },
      {
        idHint: "test-plugin",
        source: path.join(dirB, "index.ts"),
        rootDir: dirB,
        origin: "global",
      },
    ];

    const registry = loadPluginManifestRegistry({
      candidates,
      cache: false,
    });

    const duplicateWarnings = registry.diagnostics.filter(
      (d) => d.level === "warn" && d.message?.includes("duplicate plugin id"),
    );
    expect(duplicateWarnings.length).toBe(1);
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
      {
        idHint: "feishu",
        source: path.join(realDir, "index.ts"),
        rootDir: realDir,
        origin: "bundled",
      },
      {
        idHint: "feishu",
        source: path.join(symlinkPath, "index.ts"),
        rootDir: symlinkPath,
        origin: "bundled",
      },
    ];

    const registry = loadPluginManifestRegistry({
      candidates,
      cache: false,
    });

    const duplicateWarnings = registry.diagnostics.filter(
      (d) => d.level === "warn" && d.message?.includes("duplicate plugin id"),
    );
    expect(duplicateWarnings.length).toBe(0);
  });

  it("suppresses duplicate warning when candidates have identical rootDir paths", () => {
    const dir = makeTempDir();
    const manifest = { id: "same-path-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    const candidates: PluginCandidate[] = [
      {
        idHint: "same-path-plugin",
        source: path.join(dir, "a.ts"),
        rootDir: dir,
        origin: "bundled",
      },
      {
        idHint: "same-path-plugin",
        source: path.join(dir, "b.ts"),
        rootDir: dir,
        origin: "global",
      },
    ];

    const registry = loadPluginManifestRegistry({
      candidates,
      cache: false,
    });

    const duplicateWarnings = registry.diagnostics.filter(
      (d) => d.level === "warn" && d.message?.includes("duplicate plugin id"),
    );
    expect(duplicateWarnings.length).toBe(0);
  });

  it("prefers higher-precedence origins for the same physical directory (config > workspace > global > bundled)", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    const manifest = { id: "precedence-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    // Use a different-but-equivalent path representation without requiring symlinks.
    const altDir = path.join(dir, "sub", "..");

    const candidates: PluginCandidate[] = [
      {
        idHint: "precedence-plugin",
        source: path.join(dir, "index.ts"),
        rootDir: dir,
        origin: "bundled",
      },
      {
        idHint: "precedence-plugin",
        source: path.join(altDir, "index.ts"),
        rootDir: altDir,
        origin: "config",
      },
    ];

    const registry = loadPluginManifestRegistry({
      candidates,
      cache: false,
    });

    const duplicateWarnings = registry.diagnostics.filter(
      (d) => d.level === "warn" && d.message?.includes("duplicate plugin id"),
    );
    expect(duplicateWarnings.length).toBe(0);
    expect(registry.plugins.length).toBe(1);
    expect(registry.plugins[0]?.origin).toBe("config");
  });
});

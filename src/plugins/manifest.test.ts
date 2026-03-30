import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifest, PLUGIN_MANIFEST_FILENAME } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest", tempDirs);
}

function writeManifestRaw(rootDir: string, content: string) {
  fs.writeFileSync(path.join(rootDir, PLUGIN_MANIFEST_FILENAME), content, "utf-8");
}

function writeManifestJson(rootDir: string, manifest: Record<string, unknown>) {
  writeManifestRaw(rootDir, JSON.stringify(manifest, null, 2));
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifest", () => {
  it("loads a well-formed JSON manifest", () => {
    const rootDir = makeTempDir();
    writeManifestJson(rootDir, {
      id: "test-plugin",
      configSchema: { type: "object" },
    });
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("test-plugin");
    }
  });

  it("tolerates trailing commas in the manifest (JSON5 fallback)", () => {
    const rootDir = makeTempDir();
    writeManifestRaw(
      rootDir,
      `{
  "id": "trailing-comma-plugin",
  "configSchema": { "type": "object", },
}`,
    );
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("trailing-comma-plugin");
    }
  });

  it("tolerates single-line comments in the manifest (JSON5 fallback)", () => {
    const rootDir = makeTempDir();
    writeManifestRaw(
      rootDir,
      `{
  // This is a comment
  "id": "comment-plugin",
  "configSchema": { "type": "object" }
}`,
    );
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("comment-plugin");
    }
  });

  it("tolerates multi-line comments in the manifest (JSON5 fallback)", () => {
    const rootDir = makeTempDir();
    writeManifestRaw(
      rootDir,
      `{
  /* Multi-line
     comment */
  "id": "multiline-comment-plugin",
  "configSchema": { "type": "object" }
}`,
    );
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("multiline-comment-plugin");
    }
  });

  it("tolerates unquoted property names in the manifest (JSON5 fallback)", () => {
    const rootDir = makeTempDir();
    writeManifestRaw(
      rootDir,
      `{
  id: "unquoted-keys-plugin",
  configSchema: { type: "object" }
}`,
    );
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("unquoted-keys-plugin");
    }
  });

  it("returns an error when the manifest is not found", () => {
    const rootDir = makeTempDir();
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest not found");
    }
  });

  it("returns an error when the manifest has completely invalid syntax", () => {
    const rootDir = makeTempDir();
    writeManifestRaw(rootDir, "<<<not json at all>>>");
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse plugin manifest");
    }
  });

  it("returns an error when the manifest is not an object", () => {
    const rootDir = makeTempDir();
    writeManifestRaw(rootDir, '"just a string"');
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest must be an object");
    }
  });

  it("returns an error when the manifest is missing id", () => {
    const rootDir = makeTempDir();
    writeManifestJson(rootDir, { configSchema: { type: "object" } });
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest requires id");
    }
  });

  it("returns an error when the manifest is missing configSchema", () => {
    const rootDir = makeTempDir();
    writeManifestJson(rootDir, { id: "no-schema-plugin" });
    const result = loadPluginManifest(rootDir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest requires configSchema");
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-json5", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifest JSON5 tolerance", () => {
  it("parses a standard JSON manifest without issues", () => {
    const dir = makeTempDir();
    const manifest = {
      id: "demo",
      configSchema: { type: "object" },
    };
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("demo");
    }
  });

  it("parses a manifest with trailing commas", () => {
    const dir = makeTempDir();
    const json5Content = `{
  "id": "hindsight",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
    },
  },
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("hindsight");
    }
  });

  it("parses a manifest with single-line comments", () => {
    const dir = makeTempDir();
    const json5Content = `{
  // Plugin identifier
  "id": "commented-plugin",
  "configSchema": { "type": "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("commented-plugin");
    }
  });

  it("parses a manifest with unquoted property names", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "unquoted-keys",
  configSchema: { type: "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("unquoted-keys");
    }
  });

  it("still rejects completely invalid syntax", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "not json at all {{{}}", "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse plugin manifest");
    }
  });

  it("rejects JSON5 values that parse but are not objects", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "'just a string'", "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest must be an object");
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadPluginManifest } from "./manifest.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `moltbot-manifest-test-${Date.now()}-${Math.random()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("loadPluginManifest", () => {
  it("returns error when manifest file is missing", () => {
    const dir = makeTempDir();
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });

  it("returns error when manifest is missing id", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "moltbot.plugin.json"),
      JSON.stringify({ name: "test" }),
      "utf-8",
    );
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("requires id");
    }
  });

  it("defaults configSchema to empty object schema when missing", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "moltbot.plugin.json"),
      JSON.stringify({ id: "test-plugin" }),
      "utf-8",
    );
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("test-plugin");
      expect(result.manifest.configSchema).toEqual({
        type: "object",
        additionalProperties: false,
        properties: {},
      });
    }
  });

  it("uses provided configSchema when present", () => {
    const dir = makeTempDir();
    const customSchema = {
      type: "object",
      properties: { apiKey: { type: "string" } },
    };
    fs.writeFileSync(
      path.join(dir, "moltbot.plugin.json"),
      JSON.stringify({ id: "test-plugin", configSchema: customSchema }),
      "utf-8",
    );
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.configSchema).toEqual(customSchema);
    }
  });

  it("parses optional fields correctly", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "moltbot.plugin.json"),
      JSON.stringify({
        id: "full-plugin",
        name: "Full Plugin",
        description: "A test plugin",
        version: "1.0.0",
        kind: "memory",
        channels: ["telegram"],
        providers: ["openai"],
      }),
      "utf-8",
    );
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("Full Plugin");
      expect(result.manifest.description).toBe("A test plugin");
      expect(result.manifest.version).toBe("1.0.0");
      expect(result.manifest.kind).toBe("memory");
      expect(result.manifest.channels).toEqual(["telegram"]);
      expect(result.manifest.providers).toEqual(["openai"]);
    }
  });
});

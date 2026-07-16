/** Tests that manifest-declared plugin ids canonicalize to the lowercase config key form. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { normalizePluginsConfig } from "./config-state.js";
import {
  isActivatedManifestOwner,
  resolveManifestOwnerBasePolicyBlock,
} from "./manifest-owner-policy.js";
import { loadPluginManifest } from "./manifest.js";

const tempRoots: string[] = [];

function writePluginDir(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-id-case-"));
  tempRoots.push(dir);
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf-8");
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin manifest id normalization", () => {
  it("lowercases a mixed-case manifest id", () => {
    const dir = writePluginDir({ id: "Malicious-Scraper", configSchema: { type: "object" } });
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.id).toBe("malicious-scraper");
  });

  it("blocks a mixed-case manifest id against a lowercase denylist entry", () => {
    const dir = writePluginDir({ id: "Malicious-Scraper", configSchema: { type: "object" } });
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const normalizedConfig = normalizePluginsConfig({
      enabled: true,
      deny: ["malicious-scraper"],
    });

    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id: result.manifest.id },
        normalizedConfig,
      }),
    ).toBe("blocked-by-denylist");
    expect(
      isActivatedManifestOwner({
        plugin: { id: result.manifest.id, origin: "installed", enabledByDefault: true },
        normalizedConfig,
      }),
    ).toBe(false);
  });

  it("matches a mixed-case manifest id against a lowercase allowlist entry", () => {
    const dir = writePluginDir({ id: "Trusted-Plugin", configSchema: { type: "object" } });
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const normalizedConfig = normalizePluginsConfig({
      enabled: true,
      allow: ["trusted-plugin"],
    });

    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id: result.manifest.id },
        normalizedConfig,
      }),
    ).toBeNull();
  });

  it("blocks a mixed-case manifest id disabled by a lowercase config entry", () => {
    const dir = writePluginDir({ id: "Sneaky-Plugin", configSchema: { type: "object" } });
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const normalizedConfig = normalizePluginsConfig({
      enabled: true,
      entries: { "sneaky-plugin": { enabled: false } },
    });

    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id: result.manifest.id },
        normalizedConfig,
      }),
    ).toBe("plugin-disabled");
  });

  it("rejects a mixed-case spelling of a core reserved id", () => {
    const dir = writePluginDir({ id: "Node-MCP", configSchema: { type: "object" } });
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("reserved by OpenClaw core");
  });

  it("leaves already-lowercase manifest ids unchanged", () => {
    const dir = writePluginDir({ id: "telegram", configSchema: { type: "object" } });
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.id).toBe("telegram");
  });
});

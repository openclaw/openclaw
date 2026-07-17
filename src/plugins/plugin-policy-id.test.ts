/** Tests that plugin policy comparisons are case-insensitive while manifest identity is preserved. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolvePluginActivationDecisionShared } from "./config-activation-shared.js";
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

function loadManifestId(id: string): string {
  const dir = writePluginDir({ id, configSchema: { type: "object" } });
  const result = loadPluginManifest(dir);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected manifest ${id} to load`);
  }
  return result.manifest.id;
}

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin policy id", () => {
  it("preserves a mixed-case manifest id as declared", () => {
    expect(loadManifestId("Malicious-Scraper")).toBe("Malicious-Scraper");
  });

  it("leaves already-lowercase manifest ids unchanged", () => {
    expect(loadManifestId("telegram")).toBe("telegram");
  });

  it("blocks a mixed-case manifest id against a lowercase denylist entry", () => {
    const id = loadManifestId("Malicious-Scraper");
    const normalizedConfig = normalizePluginsConfig({
      enabled: true,
      deny: ["malicious-scraper"],
    });

    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id },
        normalizedConfig,
      }),
    ).toBe("blocked-by-denylist");
    expect(
      isActivatedManifestOwner({
        plugin: { id, origin: "bundled", enabledByDefault: true },
        normalizedConfig,
      }),
    ).toBe(false);
  });

  it("blocks a mixed-case manifest id in the shared activation decision", () => {
    const id = loadManifestId("Malicious-Scraper");
    const decision = resolvePluginActivationDecisionShared({
      id,
      origin: "bundled",
      config: normalizePluginsConfig({ enabled: true, deny: ["malicious-scraper"] }),
      enabledByDefault: true,
      isBundledChannelEnabledByChannelConfig: () => false,
    });

    expect(decision).toMatchObject({
      enabled: false,
      activated: false,
      cause: "blocked-by-denylist",
    });
  });

  it("matches a mixed-case manifest id against a lowercase allowlist entry", () => {
    const id = loadManifestId("Trusted-Plugin");

    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id },
        normalizedConfig: normalizePluginsConfig({ enabled: true, allow: ["trusted-plugin"] }),
      }),
    ).toBeNull();
  });

  it("blocks a mixed-case manifest id disabled by a lowercase config entry", () => {
    const id = loadManifestId("Sneaky-Plugin");

    expect(
      resolveManifestOwnerBasePolicyBlock({
        plugin: { id },
        normalizedConfig: normalizePluginsConfig({
          enabled: true,
          entries: { "sneaky-plugin": { enabled: false } },
        }),
      }),
    ).toBe("plugin-disabled");
  });

  it("rejects a mixed-case spelling of a core reserved id", () => {
    const dir = writePluginDir({ id: "Node-MCP", configSchema: { type: "object" } });
    const result = loadPluginManifest(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("reserved by OpenClaw core");
  });
});

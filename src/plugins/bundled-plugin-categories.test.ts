// Keeps every bundled plugin assigned to the package-owned catalog taxonomy.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_CATEGORY_SLUGS } from "../../packages/plugin-package-contract/src/index.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";
import { loadPluginManifest } from "./manifest.js";

describe("bundled plugin categories", () => {
  it("assigns exactly one active purpose category to every bundled plugin", () => {
    const extensionsRoot = path.join(repoRoot, "extensions");
    const invalid: string[] = [];
    let manifestCount = 0;

    for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(extensionsRoot, entry.name, "openclaw.plugin.json");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      manifestCount += 1;
      const result = loadPluginManifest(path.dirname(manifestPath), false);
      if (!result.ok) {
        invalid.push(`${entry.name}: ${result.error}`);
        continue;
      }
      if (result.manifest.categories?.length !== 1) {
        invalid.push(`${entry.name}: expected exactly one purpose category`);
      }
      for (const category of result.manifest.categories ?? []) {
        if (!PLUGIN_CATEGORY_SLUGS.some((activeCategory) => activeCategory === category)) {
          invalid.push(`${entry.name}: retired category ${category}`);
        }
      }
    }

    expect(manifestCount).toBeGreaterThan(0);
    expect(invalid).toEqual([]);
  });

  it.each([
    { pluginId: "codex", category: "developer-tools", purpose: "coding harness" },
    { pluginId: "a2a", category: "agent-orchestration", purpose: "agent-to-agent delegation" },
    {
      pluginId: "feishu",
      category: "channels",
      purpose: "human-agent messaging despite workspace tools",
    },
    { pluginId: "document-extract", category: "documents-files", purpose: "document extraction" },
    { pluginId: "google-meet", category: "voice", purpose: "live spoken participation" },
    { pluginId: "tokenjuice", category: "context", purpose: "active-context compaction" },
    { pluginId: "team-reports", category: "data-analytics", purpose: "team activity reporting" },
    { pluginId: "diagnostics-otel", category: "infrastructure", purpose: "operational telemetry" },
  ])("classifies $pluginId by its $purpose", ({ pluginId, category }) => {
    const result = loadPluginManifest(path.join(repoRoot, "extensions", pluginId), false);
    expect(result).toMatchObject({ ok: true, manifest: { categories: [category] } });
  });
});

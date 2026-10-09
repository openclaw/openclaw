/**
 * Real-package-swap freshness coverage for transcript replay policy resolution.
 *
 * Unlike transcript-policy.test.ts, which substitutes provider objects, this
 * suite drives the real discovery → manifest registry → jiti module load path:
 * it writes a genuine provider plugin package into a temp extensions dir,
 * resolves its replay policy, replaces the package in place on disk, runs the
 * same lifecycle invalidation calls as finishOnboardingPluginInstall, and
 * requires the next same-input resolution to serve the replacement policy.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-records.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { invalidatePluginRuntimeDiscoveryAfterConfigMutation } from "../plugins/registry-refresh.js";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

const PLUGIN_ID = "replayproof";

function packageEntry(sanitizeToolCallIds: boolean): string {
  return [
    "export default {",
    `  id: "${PLUGIN_ID}",`,
    `  name: "Replay Proof",`,
    `  description: "Real package replacement proof fixture",`,
    "  register(api) {",
    "    api.registerProvider({",
    `      id: "${PLUGIN_ID}",`,
    `      label: "Replay Proof",`,
    "      auth: [],",
    `      buildReplayPolicy: () => ({ sanitizeToolCallIds: ${sanitizeToolCallIds} }),`,
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
}

function writePackage(pkgDir: string, sanitizeToolCallIds: boolean): void {
  writeFileSync(
    path.join(pkgDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: PLUGIN_ID,
        name: "Replay Proof",
        description: "Real package replacement proof fixture",
        categories: ["models"],
        providers: [PLUGIN_ID],
        enabledByDefault: true,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        modelCatalog: {
          providers: {
            [PLUGIN_ID]: {
              baseUrl: "https://replayproof.invalid/v1",
              api: "openai-completions",
              defaultModel: `${PLUGIN_ID}/demo`,
              models: [
                {
                  id: `${PLUGIN_ID}/demo`,
                  name: "Demo",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 8192,
                  maxTokens: 1024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(pkgDir, "index.js"), packageEntry(sanitizeToolCallIds));
}

function invalidateInstalledPluginCaches(): void {
  clearLoadInstalledPluginIndexInstallRecordsCache();
  clearPluginMetadataLifecycleCaches();
}

it(
  "serves the replacement package's replay policy after an in-place plugin package swap",
  { timeout: 120_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "replay-proof-"));
    const pkgDir = path.join(root, PLUGIN_ID);
    mkdirSync(pkgDir, { recursive: true });
    writePackage(pkgDir, false);

    const config = {
      plugins: { load: { paths: [pkgDir] } },
    } as unknown as OpenClawConfig;
    const params = { provider: PLUGIN_ID, config, modelApi: "openai-completions" };

    try {
      const beforeSwap = resolveTranscriptPolicy(params);
      expect(beforeSwap.sanitizeToolCallIds).toBe(false);

      // Same path, same provider id, same config: only the package content changes.
      writePackage(pkgDir, true);
      invalidateInstalledPluginCaches();
      await invalidatePluginRuntimeDiscoveryAfterConfigMutation({});

      const afterSwap = resolveTranscriptPolicy(params);
      expect(afterSwap.sanitizeToolCallIds).toBe(true);
    } finally {
      invalidateInstalledPluginCaches();
      await invalidatePluginRuntimeDiscoveryAfterConfigMutation({});
      rmSync(root, { recursive: true, force: true });
    }
  },
);

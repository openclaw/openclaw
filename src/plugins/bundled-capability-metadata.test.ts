import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeBundledPluginStringList } from "./bundled-plugin-scan.js";
import {
  BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS,
  BUNDLED_LEGACY_PLUGIN_ID_ALIASES,
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
} from "./contracts/inventory/bundled-capability-metadata.js";
import { uniqueStrings } from "./contracts/shared.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";
import type { PluginManifest } from "./manifest.js";

function readManifestRecords(): PluginManifest[] {
  const extensionsDir = path.join(repoRoot, "extensions");
  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extensionsDir, entry.name))
    .filter((pluginDir) => {
      const packagePath = path.join(pluginDir, "package.json");
      if (!fs.existsSync(packagePath)) {
        return false;
      }
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as {
        openclaw?: { extensions?: unknown };
      };
      return normalizeBundledPluginStringList(packageJson.openclaw?.extensions).length > 0;
    })
    .map(
      (pluginDir) =>
        JSON.parse(
          fs.readFileSync(path.join(pluginDir, "openclaw.plugin.json"), "utf-8"),
        ) as PluginManifest,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

describe("bundled capability metadata", () => {
  it("keeps contract snapshots aligned with bundled plugin manifests", () => {
    const expected = readManifestRecords()
      .map((manifest) => ({
        pluginId: manifest.id,
        cliBackendIds: uniqueStrings(manifest.cliBackends, (value) => value.trim()),
        providerIds: uniqueStrings(manifest.providers, (value) => value.trim()),
        speechProviderIds: uniqueStrings(manifest.contracts?.speechProviders, (value) =>
          value.trim(),
        ),
        realtimeTranscriptionProviderIds: uniqueStrings(
          manifest.contracts?.realtimeTranscriptionProviders,
          (value) => value.trim(),
        ),
        realtimeVoiceProviderIds: uniqueStrings(
          manifest.contracts?.realtimeVoiceProviders,
          (value) => value.trim(),
        ),
        mediaUnderstandingProviderIds: uniqueStrings(
          manifest.contracts?.mediaUnderstandingProviders,
          (value) => value.trim(),
        ),
        imageGenerationProviderIds: uniqueStrings(
          manifest.contracts?.imageGenerationProviders,
          (value) => value.trim(),
        ),
        videoGenerationProviderIds: uniqueStrings(
          manifest.contracts?.videoGenerationProviders,
          (value) => value.trim(),
        ),
        musicGenerationProviderIds: uniqueStrings(
          manifest.contracts?.musicGenerationProviders,
          (value) => value.trim(),
        ),
        webFetchProviderIds: uniqueStrings(manifest.contracts?.webFetchProviders, (value) =>
          value.trim(),
        ),
        webSearchProviderIds: uniqueStrings(manifest.contracts?.webSearchProviders, (value) =>
          value.trim(),
        ),
        toolNames: uniqueStrings(manifest.contracts?.tools, (value) => value.trim()),
      }))
      .filter(
        (entry) =>
          entry.cliBackendIds.length > 0 ||
          entry.providerIds.length > 0 ||
          entry.speechProviderIds.length > 0 ||
          entry.realtimeTranscriptionProviderIds.length > 0 ||
          entry.realtimeVoiceProviderIds.length > 0 ||
          entry.mediaUnderstandingProviderIds.length > 0 ||
          entry.imageGenerationProviderIds.length > 0 ||
          entry.videoGenerationProviderIds.length > 0 ||
          entry.musicGenerationProviderIds.length > 0 ||
          entry.webFetchProviderIds.length > 0 ||
          entry.webSearchProviderIds.length > 0 ||
          entry.toolNames.length > 0,
      )
      .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

    expect(BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS).toEqual(expected);
  });

  it("keeps lightweight alias maps aligned with bundled plugin manifests", () => {
    const manifests = readManifestRecords();
    const expectedLegacyAliases = Object.fromEntries(
      manifests
        .flatMap((manifest) =>
          (manifest.legacyPluginIds ?? []).map((legacyPluginId) => [legacyPluginId, manifest.id]),
        )
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const expectedAutoEnableProviderPluginIds = Object.fromEntries(
      manifests
        .flatMap((manifest) =>
          (manifest.autoEnableWhenConfiguredProviders ?? []).map((providerId) => [
            providerId,
            manifest.id,
          ]),
        )
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );

    expect(BUNDLED_LEGACY_PLUGIN_ID_ALIASES).toEqual(expectedLegacyAliases);
    expect(BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS).toEqual(expectedAutoEnableProviderPluginIds);
  });
});

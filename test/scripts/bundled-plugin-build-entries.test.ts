import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  listBundledPluginBuildEntries,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";

describe("bundled plugin build entries", () => {
  it("includes manifest-less runtime core support packages in dist build entries", () => {
    const entries = listBundledPluginBuildEntries();

    expect(entries).toMatchObject({
      "extensions/image-generation-core/api": "extensions/image-generation-core/api.ts",
      "extensions/image-generation-core/runtime-api":
        "extensions/image-generation-core/runtime-api.ts",
      "extensions/media-understanding-core/runtime-api":
        "extensions/media-understanding-core/runtime-api.ts",
      "extensions/speech-core/api": "extensions/speech-core/api.ts",
      "extensions/speech-core/runtime-api": "extensions/speech-core/runtime-api.ts",
    });
  });

  it("keeps the Matrix packaged runtime shim in bundled plugin build entries", () => {
    const entries = listBundledPluginBuildEntries();

    expect(entries).toMatchObject({
      "extensions/matrix/plugin-entry.handlers.runtime":
        "extensions/matrix/plugin-entry.handlers.runtime.ts",
    });
  });

  it("packs runtime core support packages without requiring plugin manifests", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toContain("dist/extensions/image-generation-core/package.json");
    expect(artifacts).toContain("dist/extensions/image-generation-core/runtime-api.js");
    expect(artifacts).not.toContain("dist/extensions/image-generation-core/openclaw.plugin.json");
    expect(artifacts).toContain("dist/extensions/media-understanding-core/runtime-api.js");
    expect(artifacts).not.toContain(
      "dist/extensions/media-understanding-core/openclaw.plugin.json",
    );
    expect(artifacts).toContain("dist/extensions/speech-core/runtime-api.js");
    expect(artifacts).not.toContain("dist/extensions/speech-core/openclaw.plugin.json");
  });

  it("packs the Matrix packaged runtime shim", () => {
    const artifacts = listBundledPluginPackArtifacts();

    expect(artifacts).toContain("dist/extensions/matrix/plugin-entry.handlers.runtime.js");
  });

  it("keeps the Telegram setup entry on packed top-level sidecars", () => {
    const setupEntry = fs.readFileSync("extensions/telegram/setup-entry.ts", "utf8");
    const artifacts = listBundledPluginPackArtifacts();

    expect(setupEntry).toContain('specifier: "./setup-plugin-api.js"');
    expect(setupEntry).toContain('specifier: "./secret-contract-api.js"');
    expect(setupEntry).not.toContain("./src/channel.setup.js");
    expect(setupEntry).not.toContain("./src/secret-contract.js");
    expect(artifacts).toContain("dist/extensions/telegram/setup-plugin-api.js");
    expect(artifacts).toContain("dist/extensions/telegram/secret-contract-api.js");
  });
});

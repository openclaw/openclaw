// Verifies bundled manifest contract resolution honors explicit plugin scopes.
import { describe, expect, it, vi } from "vitest";
import { resolveEnabledBundledManifestContractPlugins } from "./bundled-manifest-contract-plugins.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  loadManifestContractSnapshot: vi.fn(),
}));

vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestContractSnapshot: mocks.loadManifestContractSnapshot,
}));

const bundledContractPlugin = createPluginManifestRecordFixture({
  id: "document-extract",
  enabledByDefault: true,
  source: "bundled",
  rootDir: "/tmp/document-extract",
  manifestPath: "/tmp/document-extract/openclaw.plugin.json",
  contracts: {
    documentExtractors: ["pdf"],
  },
});

describe("resolveEnabledBundledManifestContractPlugins", () => {
  it("treats an explicit empty plugin scope as matching no contract owners", () => {
    mocks.loadManifestContractSnapshot.mockReturnValue({
      plugins: [bundledContractPlugin],
    });

    expect(
      resolveEnabledBundledManifestContractPlugins({
        contract: "documentExtractors",
      }).map((plugin) => plugin.id),
    ).toStrictEqual(["document-extract"]);
    expect(
      resolveEnabledBundledManifestContractPlugins({
        onlyPluginIds: [],
        contract: "documentExtractors",
      }),
    ).toStrictEqual([]);
  });
});

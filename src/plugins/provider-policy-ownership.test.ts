import { describe, expect, it } from "vitest";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { listTrustedExternalProviderPolicyOwners } from "./provider-public-artifacts.js";

describe("provider policy declaration ownership", () => {
  it.each([
    [" FIXTURE-TEXT ", true],
    [" fixture-cli ", true],
    ["FIXTURE-EMBEDDING", true],
    [" TEXT-ALIAS ", true],
    ["cli-alias", true],
    ["embedding-alias", true],
    ["orphan-alias", false],
    ["scoped-alias", false],
    ["empty-target", false],
    ["setup-only", false],
    ["setup-cli", false],
    [" ", true],
  ] as const)("preserves declared policy ownership for %j", (query, matches) => {
    const owner = createPluginManifestRecordFixture({
      id: "fixture-owner",
      origin: "global",
      trustedOfficialInstall: true,
      providers: [" fixture-text "],
      cliBackends: [" FIXTURE-CLI "],
      contracts: { embeddingProviders: [" fixture-embedding "] },
      setup: { providers: [{ id: "setup-only" }], cliBackends: ["setup-cli"] },
      providerAuthAliases: {
        " text-alias ": " fixture-text ",
        "cli-alias": "fixture-cli",
        "embedding-alias": "fixture-embedding",
        "orphan-alias": "missing",
        "scoped-alias": { provider: "fixture-text", baseUrls: ["https://fixture.example.test"] },
        "empty-target": " ",
        "": "fixture-text",
      },
    });

    expect(listTrustedExternalProviderPolicyOwners(query, { plugins: [owner] })).toEqual(
      matches ? [owner] : [],
    );
  });

  it("does not treat empty declarations as policy ownership", () => {
    const owner = createPluginManifestRecordFixture({
      id: "empty-owner",
      trustedOfficialInstall: true,
      providers: [""],
      cliBackends: [" "],
      contracts: { embeddingProviders: [""] },
      providerAuthAliases: { empty: " " },
    });
    for (const query of ["", " ", "empty"]) {
      expect(listTrustedExternalProviderPolicyOwners(query, { plugins: [owner] })).toEqual([]);
    }
  });

  it("orders trusted external matches stably without reordering the registry", () => {
    const owner = (id: string, rootDir: string, trustedOfficialInstall = true) =>
      createPluginManifestRecordFixture({
        id,
        rootDir,
        origin: "global",
        trustedOfficialInstall,
        providers: ["fixture-provider"],
      });
    const last = owner("z-owner", "/fixture/z");
    const first = owner("a-owner", "/fixture/first");
    const equal = owner("a-owner", "/fixture/equal");
    const untrusted = owner("0-owner", "/fixture/untrusted", false);
    const plugins = [last, first, untrusted, equal];

    expect(listTrustedExternalProviderPolicyOwners("fixture-provider", { plugins })).toEqual([
      first,
      equal,
      last,
    ]);
    expect(plugins).toEqual([last, first, untrusted, equal]);
  });
});

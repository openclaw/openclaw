import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  createPluginCache,
  invalidatePluginCacheMetadata,
  withPluginCache,
} from "./plugin-cache.js";
import {
  finalizePluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "./plugin-metadata.test-support.js";
import {
  listProviderPolicyOwners,
  listTrustedExternalProviderPolicyOwners,
  resolveBundledProviderPolicyOwner,
} from "./provider-policy-owners.js";

function withRegistry(
  plugins: PluginManifestRecord[],
  mode: "mutable" | "projected" | "restored",
  run: (registry: { plugins: readonly PluginManifestRecord[] }) => void,
): void {
  withPluginCache(createPluginCache(), () => {
    if (mode === "mutable") {
      run({ plugins });
      return;
    }
    const snapshot = finalizePluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({ plugins }),
    );
    if (mode === "restored") {
      const { normalizePluginId: _normalizePluginId, ...transfer } = snapshot;
      run(restorePluginMetadataSnapshot(structuredClone(transfer)));
    } else {
      run(
        projectPluginMetadataSnapshot(
          snapshot,
          plugins.map((plugin) => plugin.id),
        ),
      );
    }
  });
}

describe("provider policy declaration ownership", () => {
  it.each(
    (
      [
        [" TEXT-ALIAS ", true],
        ["orphan-alias", false],
        ["scoped-alias", false],
        ["inherited-alias", false],
        ["setup-only", false],
      ] as const
    ).flatMap(([query, matches]) =>
      (["mutable", "projected"] as const).map((mode) => ({ query, matches, mode })),
    ),
  )("preserves declared policy ownership for $query ($mode)", ({ query, matches, mode }) => {
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
    Object.setPrototypeOf(owner.providerAuthAliases, { "inherited-alias": "fixture-text" });
    Object.defineProperty(owner.providerAuthAliases, "hidden-alias", {
      value: "fixture-text",
      enumerable: false,
    });

    withRegistry([owner], mode, (registry) => {
      expect(listTrustedExternalProviderPolicyOwners(query, registry)).toEqual(
        matches ? [owner] : [],
      );
    });
  });

  it.each(["mutable", "projected"] as const)(
    "orders trusted external matches stably without reordering the %s registry",
    (mode) => {
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

      withRegistry(plugins, mode, (registry) => {
        const owners = listTrustedExternalProviderPolicyOwners("fixture-provider", registry);
        expect(owners).toEqual([first, equal, last]);
        owners.reverse();
        owners.pop();
        expect(listTrustedExternalProviderPolicyOwners("fixture-provider", registry)).toEqual([
          first,
          equal,
          last,
        ]);
        expect(registry.plugins).toEqual([last, first, untrusted, equal]);
      });
    },
  );

  it.each(["mutable", "restored"] as const)(
    "keeps bundled first-winner precedence separate from trusted installed ownership (%s)",
    (mode) => {
      const owner = (id: string, rootDir: string, origin: PluginManifestRecord["origin"]) =>
        createPluginManifestRecordFixture({
          id,
          rootDir,
          origin,
          providers: ["fixture-provider"],
          providerAuthAliases: { "fixture-alias": "fixture-provider" },
          trustedOfficialInstall: origin === "global",
        });
      const installed = owner("0-installed", "/fixture/installed", "global");
      const last = owner("z-bundled", "/fixture/last", "bundled");
      const first = owner("a-bundled", "/fixture/first", "bundled");
      const equal = owner("a-bundled", "/fixture/equal", "bundled");
      withRegistry([installed, last, first, equal], mode, (registry) => {
        expect(resolveBundledProviderPolicyOwner("fixture-alias", registry)).toEqual(first);
        expect(listTrustedExternalProviderPolicyOwners("fixture-alias", registry)).toEqual([
          installed,
        ]);
        expect(listProviderPolicyOwners("fixture-alias", registry)).toEqual([first, installed]);
      });
    },
  );
});

describe("provider policy inventory lifetime", () => {
  it.each([false, true])("observes mutable registry edits (rebased: %s)", (rebased) => {
    withPluginCache(createPluginCache(), () => {
      const owner = createPluginManifestRecordFixture({
        id: "mutable-owner",
        origin: "global",
        providers: ["before"],
        providerAuthAliases: { alias: "before" },
        trustedOfficialInstall: true,
      });
      const registry = rebased
        ? createPluginMetadataSnapshotFixture({ plugins: [owner] })
        : { plugins: [owner] };
      const mutableOwner = registry.plugins[0]!;
      expect(listTrustedExternalProviderPolicyOwners("alias", registry)).toEqual([mutableOwner]);
      mutableOwner.providers = ["after"];
      expect(listTrustedExternalProviderPolicyOwners("alias", registry)).toEqual([]);
      expect(listTrustedExternalProviderPolicyOwners("after", registry)).toEqual([mutableOwner]);
      mutableOwner.trustedOfficialInstall = false;
      expect(listTrustedExternalProviderPolicyOwners("after", registry)).toEqual([]);
    });
  });

  it("retains each narrowed generation through replacement and operation invalidation", () => {
    const cache = createPluginCache();
    withPluginCache(cache, () => {
      const owner = (id: string) => ({
        id,
        origin: "global" as const,
        providers: ["fixture-provider"],
        trustedOfficialInstall: true,
      });
      const before = finalizePluginMetadataSnapshot(
        createPluginMetadataSnapshotFixture({ plugins: [owner("before")] }),
      );
      const empty = projectPluginMetadataSnapshot(before, []);
      for (const registry of [empty, empty.manifestRegistry]) {
        expect(listTrustedExternalProviderPolicyOwners("fixture-provider", registry)).toEqual([]);
      }
      invalidatePluginCacheMetadata(cache);
      const after = finalizePluginMetadataSnapshot(
        createPluginMetadataSnapshotFixture({ plugins: [owner("after")] }),
      );
      for (const registry of [before, before.manifestRegistry]) {
        expect(listTrustedExternalProviderPolicyOwners("fixture-provider", registry)).toEqual([
          before.plugins[0],
        ]);
      }
      for (const registry of [empty, empty.manifestRegistry]) {
        expect(listTrustedExternalProviderPolicyOwners("fixture-provider", registry)).toEqual([]);
      }
      for (const registry of [after, after.manifestRegistry]) {
        expect(listTrustedExternalProviderPolicyOwners("fixture-provider", registry)).toEqual([
          after.plugins[0],
        ]);
      }
    });
  });
});

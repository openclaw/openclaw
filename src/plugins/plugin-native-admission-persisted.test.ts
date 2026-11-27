import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import {
  getPluginMetadataSnapshotCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { captureResources } from "./plugin-generation-capture.test-support.js";
import { preparePluginGenerationArtifact } from "./plugin-generation-worker.js";
import {
  nativeAdmissionStateFor,
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

it("shares dormant installed native members until an admitted plugin updates a companion", async () => {
  await withOpenClawTestState({ label: "installed-native-members" }, async (state) => {
    await using resources = captureResources();
    const env = { ...state.env, OPENCLAW_BUNDLED_PLUGINS_DIR: state.path("bundled") };
    fs.mkdirSync(env.OPENCLAW_BUNDLED_PLUGINS_DIR);
    const install = (id: string) =>
      writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: id,
        pluginId: id,
        version: "1.0.0",
      });
    const root = install("native-fixture");
    const peer = install("active-peer");
    const never = install("never-active");
    const marker = path.join(root, "addon.bin");
    fs.writeFileSync(marker, "native fixture");
    fs.writeFileSync(path.join(root, "companion.txt"), "companion");
    const config = (enabled: boolean): OpenClawConfig => ({
      agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
      plugins: {
        allow: ["native-fixture", "active-peer", "never-active"],
        load: { paths: [root, peer, never] },
        entries: {
          "native-fixture": { enabled },
          "active-peer": { enabled: true },
          "never-active": { enabled: false },
        },
        slots: { memory: "none" },
      },
    });
    const store = { stateDir: state.stateDir };
    const initial = loadInstalledPluginIndex({
      ...store,
      env,
      workspaceDir: state.workspaceDir,
      config: config(true),
    });
    await writePersistedInstalledPluginIndex(initial, store);
    const first = resources.cache();
    preparePluginNativeAdmissions(initial, first);
    const artifact = resources.capture(first, root);
    expect(fs.readFileSync(artifact.resolve(marker), "utf8")).toBe("native fixture");
    await settlePluginNativeAdmissions(first);
    await artifact.disposeAsync();
    await retirePluginCache(first);

    const persisted = structuredClone(
      await withPluginCache(resources.cache(), () => readPersistedInstalledPluginIndex(store)),
    );
    const installed = persisted!.plugins.find((row) => row.pluginId === "native-fixture")!;
    const [key, receipt] = Object.entries(installed.sourceAdmissions!)[0]!;
    const id = receipt.nativeArtifacts[marker]!.namespace;
    const legacy = receipt.nativeNamespaces[id]!.members["companion.txt"]!;
    const expectedDigest = legacy.contentHash;
    expect(expectedDigest).toMatch(/^[a-f0-9]{64}$/);
    const complete = freezeTrustedJsonSnapshot(structuredClone(persisted!));
    const warm = resources.cache();
    preparePluginNativeAdmissions(complete, warm);
    const warmNamespace = nativeAdmissionStateFor(warm).namespaces.get(id)!;
    const members = warmNamespace.members;
    const warmArtifact = resources.capture(warm, root);
    const warmPath = warmArtifact.resolve(marker);
    expect(fs.readFileSync(warmPath, "utf8")).toBe("native fixture");
    // A symlink leaves inode identities intact; Windows may need a physical reference.
    if (fs.lstatSync(warmPath).isSymbolicLink()) {
      expect(warmNamespace.members).toBe(members);
    }
    await warmArtifact.disposeAsync();
    // A valid older receipt can have a companion size without its digest.
    delete legacy.contentHash;
    await writePersistedInstalledPluginIndex(persisted!, store);

    const snapshot = (enabled: boolean) =>
      withPluginCache(resources.cache(), () =>
        resolveConfigWidePluginMetadataSnapshotAsync({
          ...store,
          env,
          config: config(enabled),
          allowCurrent: false,
        }),
      );
    const metadata = await snapshot(false);
    const cache = getPluginMetadataSnapshotCache(metadata);
    const native = nativeAdmissionStateFor(cache);
    const record = metadata.index.plugins.find((row) => row.pluginId === "native-fixture")!;
    expect(record.enabled).toBe(false);
    const original = record.sourceAdmissions![key]!.nativeNamespaces[id]!;
    expect(native.namespaces.get(id)?.members).toBe(original.members);
    expect(
      Object.keys(
        metadata.index.plugins.find((row) => row.pluginId === "never-active")!.sourceAdmissions ??
          {},
      ),
    ).toHaveLength(0);
    const peerSource = path.join(peer, "dist", "index.js");
    const unrelated = await withPluginCache(cache, () =>
      preparePluginGenerationArtifact({ rootDir: peer, source: peerSource }),
    );
    await unrelated.artifact.disposeAsync();
    expect(native.namespaces.get(id)?.members).toBe(original.members);

    const mutable = structuredClone(metadata.index);
    const isolated = resources.cache();
    preparePluginNativeAdmissions(mutable, isolated);
    const mutableRecord = mutable.plugins.find((row) => row.pluginId === "native-fixture")!;
    const mutableMembers = mutableRecord.sourceAdmissions![key]!.nativeNamespaces[id]!.members;
    expect(nativeAdmissionStateFor(isolated).namespaces.get(id)?.members["companion.txt"]).not.toBe(
      mutableMembers["companion.txt"],
    );

    const enabled = await snapshot(true);
    const active = getPluginMetadataSnapshotCache(enabled);
    const source = enabled.index.plugins.find((row) => row.pluginId === "native-fixture")!;
    const prior = source.sourceAdmissions![key]!.nativeNamespaces[id]!;
    const entry = path.join(root, "dist", "index.js");
    expect(source.source).toBe(entry);
    const preparation = await withPluginCache(active, () =>
      preparePluginGenerationArtifact({ rootDir: root, source: entry }),
    );
    try {
      expect(fs.readFileSync(preparation.artifact.resolve(marker), "utf8")).toBe("native fixture");
      const updated = nativeAdmissionStateFor(active).receipts.get(key)!;
      const newId = updated.nativeArtifacts[marker]!.namespace;
      expect(updated.nativeNamespaces[newId]?.members["companion.txt"]?.contentHash).toBe(
        expectedDigest,
      );
      expect(prior.members["companion.txt"]?.contentHash).toBeUndefined();
    } finally {
      await preparation.artifact.disposeAsync();
    }
  });
});

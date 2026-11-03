import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { indexStoreFixture } from "./installed-plugin-index-family.test-support.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import {
  refreshPersistedInstalledPluginIndexWithReceipt as refresh,
  restorePersistedInstalledPluginIndexIfCurrent,
  updateInstalledPluginSourceSnapshots,
} from "./installed-plugin-index-store-write.js";
import { parseInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { diffInstalledPluginIndexInvalidationReasons } from "./installed-plugin-index.js";
import { withPluginLifecycleLeaseAsync } from "./plugin-lifecycle-lease.js";
import { createInstalledPluginIndexCandidate } from "./test-helpers/installed-plugin-index.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture() {
  const stateDir = tempDirs.make("plugin-snapshot-index");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const rootDir = path.join(stateDir, "demo");
  fs.mkdirSync(rootDir);
  const candidate = recordPluginCandidateInstallOwner(
    createInstalledPluginIndexCandidate(rootDir),
    "package-owner",
  );
  const digests = { contentDigest: "c".repeat(64), dependencyClosureDigest: "d".repeat(64) };
  const installRecord = {
    source: "npm" as const,
    spec: "demo@1.0.0",
    installPath: rootDir,
    sourceSnapshotDigests: { demo: digests },
  };
  const descriptor = {
    formatVersion: 1,
    generation: "generation-one",
    installRecordHash: hashJson(installRecord),
    ...digests,
    buildResolutionDigest: "resolution-digest",
    platform: process.platform,
    arch: process.arch,
    abi: process.versions.modules,
    artifact: {
      path: path.join(stateDir, "artifact"),
      identity: "identity",
      manifestIdentity: "manifest-identity",
      manifestDigest: "manifest-digest",
      tokenIdentity: "token-identity",
    },
  };
  const publication = { pluginId: "demo", installOwner: "package-owner", rootDir, descriptor };
  return {
    ...indexStoreFixture(stateDir, env),
    candidate,
    descriptor,
    publication,
    params: {
      env,
      candidates: [candidate],
      installRecords: { "package-owner": installRecord },
      reason: "source-changed" as const,
    },
  };
}

describe("installed source snapshot metadata", () => {
  it("publishes snapshots in the record transaction and retains their installation revision on refresh", async () => {
    const f = fixture();
    const first = await refresh({ ...f.params, sourceSnapshots: [f.publication] });
    const expected = { ...f.descriptor, installedRevision: first.revision };
    expect(first.index.plugins[0]?.sourceSnapshot).toEqual(expected);
    expect((await f.read())?.plugins[0]?.sourceSnapshot).toEqual(expected);
    const second = await refresh(f.params);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.index.plugins[0]?.sourceSnapshot).toEqual(expected);
  });

  it("replaces same-record generations and invalidates registry consumers", async () => {
    const f = fixture();
    const first = await refresh({ ...f.params, sourceSnapshots: [f.publication] });
    const second = await refresh({
      ...f.params,
      sourceSnapshots: [
        { ...f.publication, descriptor: { ...f.descriptor, generation: "generation-two" } },
      ],
    });
    expect(second.index.plugins[0]?.sourceSnapshot).toEqual({
      ...f.descriptor,
      generation: "generation-two",
      installedRevision: second.revision,
    });
    expect(diffInstalledPluginIndexInvalidationReasons(first.index, second.index)).toContain(
      "source-changed",
    );
  });

  it("rejects mismatched and duplicate publications without publishing the row", async () => {
    const f = fixture();
    await refresh(f.params);
    const before = f.row();
    for (const sourceSnapshots of [
      [{ ...f.publication, installOwner: "wrong-owner" }],
      [f.publication, f.publication],
      [{ ...f.publication, descriptor: { ...f.descriptor, contentDigest: "e".repeat(64) } }],
    ]) {
      await expect(refresh({ ...f.params, sourceSnapshots })).rejects.toThrow(/snapshot/i);
      expect(f.row()).toEqual(before);
    }
  });

  it("invalidates snapshots when the install record changes and restores the exact predecessor on rollback", async () => {
    const f = fixture();
    const first = await refresh({ ...f.params, sourceSnapshots: [f.publication] });
    const second = await refresh({
      ...f.params,
      installRecords: {
        "package-owner": { ...f.params.installRecords["package-owner"], spec: "demo@2.0.0" },
      },
    });
    expect(second.index.plugins[0]).not.toHaveProperty("sourceSnapshot");
    await withPluginLifecycleLeaseAsync({ env: f.env }, async (lease) => {
      expect(
        await restorePersistedInstalledPluginIndexIfCurrent(second.previous, second.revision, {
          env: f.env,
          lease,
        }),
      ).toBe(true);
    });
    expect((await f.read())?.plugins[0]?.sourceSnapshot).toEqual({
      ...f.descriptor,
      installedRevision: first.revision,
    });
  });

  it("conditionally publishes and retires source facts without rediscovering a missing original tree", async () => {
    const f = fixture();
    await refresh(f.params);
    fs.rmSync(f.publication.rootDir, { recursive: true, force: true });
    const first = await updateInstalledPluginSourceSnapshots({
      env: f.env,
      sourceSnapshots: [f.publication],
    });
    expect(first).not.toBeNull();
    expect(
      await updateInstalledPluginSourceSnapshots({ env: f.env, sourceSnapshots: [f.publication] }),
    ).toBeNull();
    const expectedSnapshot = first?.index.plugins[0]?.sourceSnapshot;
    const removal = {
      pluginId: "demo",
      installOwner: "package-owner",
      rootDir: f.publication.rootDir,
      installRecordHash: f.descriptor.installRecordHash,
      expectedSnapshot,
      warning: {
        artifactPath: f.descriptor.artifact.path,
        message: "Snapshot permissions widened; capturing the original source.",
      },
    };
    expect(
      await updateInstalledPluginSourceSnapshots({
        env: f.env,
        sourceSnapshotRemovals: [{ ...removal, expectedSnapshot: null }],
      }),
    ).toBeNull();
    const removed = await updateInstalledPluginSourceSnapshots({
      env: f.env,
      sourceSnapshotRemovals: [removal],
    });
    expect(removed?.index.plugins[0]).not.toHaveProperty("sourceSnapshot");
    expect((await f.read())?.plugins[0]?.sourceSnapshotWarning).toEqual(removal.warning);
    expect(removed?.index.diagnostics).toContainEqual({
      level: "warn",
      pluginId: "demo",
      source: removal.warning.artifactPath,
      code: "plugin-source-snapshot-invalid",
      message: `Source snapshot ${removal.warning.artifactPath}: ${removal.warning.message}`,
    });
    const replaced = await updateInstalledPluginSourceSnapshots({
      env: f.env,
      sourceSnapshots: [f.publication],
    });
    expect(replaced?.index.plugins[0]?.sourceSnapshotWarning).toEqual(removal.warning);
    expect(replaced?.index.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "plugin-source-snapshot-invalid" })]),
    );
    fs.mkdirSync(f.publication.rootDir);
    createInstalledPluginIndexCandidate(f.publication.rootDir);
    const reinstalled = await refresh({ ...f.params, sourceSnapshots: [f.publication] });
    expect(reinstalled.index.plugins[0]).not.toHaveProperty("sourceSnapshotWarning");
    expect(reinstalled.index.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "plugin-source-snapshot-invalid" })]),
    );
  });

  it("leaves legacy installs without content digests on the capture path", async () => {
    const f = fixture();
    const { sourceSnapshotDigests: _digests, ...legacyRecord } =
      f.params.installRecords["package-owner"];
    const result = await refresh({
      ...f.params,
      installRecords: { "package-owner": legacyRecord },
    });
    expect(result.index.plugins[0]).not.toHaveProperty("sourceSnapshot");
    await expect(
      updateInstalledPluginSourceSnapshots({
        env: f.env,
        sourceSnapshots: [
          {
            ...f.publication,
            descriptor: { ...f.descriptor, installRecordHash: hashJson(legacyRecord) },
          },
        ],
      }),
    ).rejects.toThrow(/snapshot content/i);
    expect((await f.read())?.plugins[0]).not.toHaveProperty("sourceSnapshot");
  });

  it("retains exact displaced generations across rollback until collection acknowledges them", async () => {
    const f = fixture();
    const first = await refresh({ ...f.params, sourceSnapshots: [f.publication] });
    const firstDescriptor = { ...f.descriptor, installedRevision: first.revision };
    const second = await refresh({
      ...f.params,
      sourceSnapshots: [
        { ...f.publication, descriptor: { ...f.descriptor, generation: "second" } },
      ],
    });
    const secondDescriptor = {
      ...f.descriptor,
      generation: "second",
      installedRevision: second.revision,
    };
    expect(second.index.retiredSourceSnapshots).toEqual([firstDescriptor]);
    await withPluginLifecycleLeaseAsync({ env: f.env }, async (lease) => {
      expect(
        await restorePersistedInstalledPluginIndexIfCurrent(second.previous, second.revision, {
          env: f.env,
          lease,
        }),
      ).toBe(true);
    });
    const restored = await f.read();
    expect(restored?.plugins[0]?.sourceSnapshot).toEqual(firstDescriptor);
    expect(restored?.retiredSourceSnapshots).toEqual([secondDescriptor]);
    await updateInstalledPluginSourceSnapshots({
      env: f.env,
      collectedSourceSnapshots: [{ ...secondDescriptor, generation: "unrelated" }],
    });
    expect((await f.read())?.retiredSourceSnapshots).toEqual([secondDescriptor]);
    await expect(
      updateInstalledPluginSourceSnapshots({
        env: f.env,
        collectedSourceSnapshots: [firstDescriptor],
      }),
    ).rejects.toThrow("active plugin source snapshot");
    await updateInstalledPluginSourceSnapshots({
      env: f.env,
      collectedSourceSnapshots: [secondDescriptor],
    });
    expect((await f.read())?.retiredSourceSnapshots).toBeUndefined();
  });

  it("keeps first-install rollback artifact authority when the prior index was absent", async () => {
    const f = fixture();
    const first = await refresh({ ...f.params, sourceSnapshots: [f.publication] });
    await withPluginLifecycleLeaseAsync({ env: f.env }, async (lease) => {
      expect(
        await restorePersistedInstalledPluginIndexIfCurrent(null, first.revision, {
          env: f.env,
          lease,
        }),
      ).toBe(true);
    });
    const restored = await f.read();
    expect(restored?.plugins).toEqual([]);
    expect(restored?.installRecords).toEqual({});
    expect(restored?.retiredSourceSnapshots).toEqual([
      { ...f.descriptor, installedRevision: first.revision },
    ]);
  });

  it.each([null, { formatVersion: 999, broken: true }])(
    "keeps malformed named snapshots visible at ingress: %j",
    async (sourceSnapshot) => {
      const f = fixture();
      const result = await refresh(f.params);
      const withSnapshot = {
        ...result.index,
        plugins: result.index.plugins.map((plugin) =>
          Object.assign({}, plugin, { sourceSnapshot }),
        ),
      };
      expect(parseInstalledPluginIndex(withSnapshot)?.plugins[0]).toHaveProperty(
        "sourceSnapshot",
        sourceSnapshot,
      );
      await f.write(withSnapshot);
      expect((await f.read())?.plugins[0]).toHaveProperty("sourceSnapshot", sourceSnapshot);
    },
  );
});

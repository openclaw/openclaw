import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { withPluginCohortConfigCapture } from "../config/plugin-cohort-recovery.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { pluginCohortPublicationContext } from "../infra/update-plugin-cohort-context.js";
import type { PluginCohortRecovery } from "../infra/update-plugin-cohort-schema.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import type { UpdateRecoveryRecord } from "../infra/update-run-recovery-schema.js";
import * as recoveryStore from "../infra/update-run-recovery-store.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import * as recordCommit from "./install-record-commit.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import {
  readPersistedInstalledPluginIndexInstallRecordsAsync,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./installed-plugin-index-records.js";
import { INSTALLED_PLUGIN_INDEX_STATE_KEY } from "./installed-plugin-index-row.js";
import {
  restorePersistedInstalledPluginIndexIfCurrent,
  refreshPersistedInstalledPluginIndexWithReceipt,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import { withPluginLifecycleLeaseAsync } from "./plugin-lifecycle-lease.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";
import { readPluginCohortArtifactIdentity } from "./update-cohort-artifacts.js";
import {
  beginUpdatePluginCohort,
  recordPluginCohortRetentionMarker,
  settleUpdatePluginCohort,
} from "./update-cohort-recovery.js";

afterEach(() => vi.restoreAllMocks());
const fence = { assertCurrent() {} };
const config = { plugins: { enabled: false } };
const packageName = "@example/cohort-fixture";

function generation(state: OpenClawTestState, version: string) {
  writeManagedNpmPlugin({ stateDir: state.stateDir, packageName, pluginId: "fixture", version });
  const npmDir = state.statePath("npm");
  const npmRoot = resolvePluginNpmGenerationProjectDir({
    npmDir,
    packageName,
    generationKey: version,
  });
  fs.renameSync(resolvePluginNpmProjectDir({ npmDir, packageName }), npmRoot);
  const packageDir = path.join(npmRoot, "node_modules", ...packageName.split("/"));
  const record: PluginInstallRecord = {
    source: "npm",
    spec: `${packageName}@${version}`,
    version,
    installPath: packageDir,
  };
  return { npmRoot, packageDir, record, identity: readPluginCohortArtifactIdentity(packageDir) };
}

async function fixture(state: OpenClawTestState) {
  await state.writeConfig(config);
  const original = generation(state, "1.0.0");
  const middle = generation(state, "2.0.0");
  const latest = generation(state, "3.0.0");
  const laterPath = writeManagedNpmPlugin({
    stateDir: state.stateDir,
    packageName: "@example/later",
    pluginId: "later",
    version: "4.0.0",
  });
  const later: PluginInstallRecord = {
    source: "npm",
    spec: "@example/later@4.0.0",
    version: "4.0.0",
    installPath: laterPath,
  };
  const current = { fixture: latest.record, later };
  await seedInstalledPluginIndex(current, { config, env: state.env });
  const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
  const reservation: UpdateRecoveryRecord = {
    runId,
    transactionId: randomUUID(),
    revision: 0,
    claimId: randomUUID(),
    claimKind: "initial",
    handoff: null,
    source: { stateDir: state.stateDir, configPath: state.configPath },
    from: { root: state.root, nodePath: process.execPath, version: "2026.10.9", buildId: "old" },
    to: { root: state.root, nodePath: process.execPath, version: "2026.10.10", buildId: "new" },
    createdAtMs: 1,
    updatedAtMs: 1,
    effects: [],
    restore: null,
    verification: null,
    primaryFailure: null,
  };
  const cohort: PluginCohortRecovery = {
    runId,
    transactionId: reservation.transactionId,
    revision: 0,
    disposition: "pending",
    installKey: state.root,
    priorArtifacts: [original, middle].map((artifact) => ({
      pluginId: "fixture",
      packageDir: artifact.packageDir,
      record: artifact.record,
      identity: artifact.identity,
      markerBefore: null,
      markerAfter: null,
    })),
    artifacts: [middle, latest].map((artifact) => ({
      pluginId: "fixture",
      packageName,
      targetNpmRoot: artifact.npmRoot,
      targetPackageDir: artifact.packageDir,
      stagedIdentity: artifact.identity,
      identity: artifact.identity,
    })),
    publications: [
      {
        kind: "records",
        records: [{ pluginId: "fixture", before: original.record, after: middle.record }],
      },
      {
        kind: "records",
        records: [{ pluginId: "fixture", before: middle.record, after: latest.record }],
      },
    ],
    settledPublications: 0,
  };
  const begin = () =>
    recoveryStore.beginPluginCohortRecovery(reservation, cohort, fence, { env: state.env });
  const settle = () =>
    settleUpdatePluginCohort({ runId, env: state.env, fence, action: "rollback" });
  return { runId, original, middle, latest, later, current, cohort, begin, settle };
}

it.each([false, true])(
  "restores the original record once without removed intermediate generations (latest removed=%s)",
  async (removeLatest) => {
    await withOpenClawTestState(
      { label: "cohort-cumulative-records", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const f = await fixture(state);
        f.begin();
        // In-memory install closures already compensated their own fresh artifacts.
        fs.rmSync(f.middle.npmRoot, { recursive: true });
        if (removeLatest) {
          fs.rmSync(f.latest.npmRoot, { recursive: true });
        }
        const commit = vi.spyOn(recordCommit, "commitPluginInstallRecordsOnly");
        const removePair = vi
          .spyOn(recoveryStore, "deletePluginCohortRecovery")
          .mockImplementationOnce(() => {
            throw new Error("settlement stopped after the atomic index restore");
          });
        await expect(f.settle()).rejects.toThrow(
          "settlement stopped after the atomic index restore",
        );
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit.mock.calls[0]?.[0].nextInstallRecords).toEqual({
          fixture: f.original.record,
          later: f.later,
        });
        expect(
          await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
        ).toEqual({
          fixture: f.original.record,
          later: f.later,
        });
        expect(
          recoveryStore.loadPluginCohortRecovery(f.runId, { env: state.env })?.cohort
            .settledPublications,
        ).toBe(2);
        await closeOpenClawStateDatabaseAsync();
        await f.settle();
        await f.settle();
        expect(commit).toHaveBeenCalledTimes(1);
        expect(removePair).toHaveBeenCalledTimes(2);
        expect(recoveryStore.loadPluginCohortRecovery(f.runId, { env: state.env })).toBeUndefined();
        expect(
          await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
        ).toEqual({
          fixture: f.original.record,
          later: f.later,
        });
      },
    );
  },
);

it("retains unpublished snapshot cleanup authority until pending rollback settles", async () => {
  await withOpenClawTestState(
    { label: "cohort-unpublished-snapshot", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const { preparePluginSourceSnapshot } = await import("./plugin-generation-worker.js");
      const { collectInstalledPluginSourceSnapshots } =
        await import("./plugin-source-snapshot-collection.js");
      const { closeDefaultRetainedNativeWorkerSource } =
        await import("../infra/worker-native-lifecycle.js");
      const f = await fixture(state);
      const snapshot = await preparePluginSourceSnapshot({
        stateDir: state.stateDir,
        rootDir: f.latest.packageDir,
      });
      try {
        const descriptor = await snapshot.publish({
          installRecordHash: hashJson(
            normalizeInstallRecordMap({ fixture: f.latest.record }).fixture,
          ),
          contentDigest: snapshot.contentDigest,
          dependencyClosureDigest: snapshot.dependencyClosureDigest,
          buildResolutionDigest: "build-resolution",
        });
        await snapshot.disposeAsync();
        f.begin();
        await collectInstalledPluginSourceSnapshots(state.stateDir, [descriptor]);
        expect(fs.existsSync(descriptor.artifact.path)).toBe(true);
        expect(
          (await readPersistedInstalledPluginIndex({ env: state.env }))?.retiredSourceSnapshots,
        ).toContainEqual({ ...descriptor, installedRevision: 0 });
        await f.settle();
        expect(fs.existsSync(descriptor.artifact.path)).toBe(false);
      } finally {
        await snapshot.disposeAsync();
        await closeDefaultRetainedNativeWorkerSource();
      }
    },
  );
});

it.each(["records", "same-record", "successor"] as const)(
  "restores exact snapshot metadata through cohort rollback (%s)",
  async (mode) => {
    await withOpenClawTestState(
      { label: "cohort-source-snapshots", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const f = await fixture(state);
        const digests = { contentDigest: "c".repeat(64), dependencyClosureDigest: "d".repeat(64) };
        const recordHash = (record: PluginInstallRecord) =>
          hashJson(normalizeInstallRecordMap({ fixture: record }).fixture);
        for (const installed of [f.original, f.middle, f.latest]) {
          installed.record.sourceSnapshotDigests = { fixture: digests };
        }
        const descriptor = (
          installed: typeof f.original,
          installedRevision: number,
        ): PluginSourceSnapshotDescriptor => ({
          formatVersion: 1,
          generation: installed.record.version!,
          installedRevision,
          installRecordHash: recordHash(installed.record),
          ...digests,
          buildResolutionDigest: "b".repeat(64),
          platform: process.platform,
          arch: process.arch,
          abi: process.versions.modules,
          artifact: {
            path: state.statePath("snapshot", String(installedRevision)),
            identity: "identity",
            manifestIdentity: "manifest",
            manifestDigest: "f".repeat(64),
            tokenIdentity: "token-identity",
          },
        });
        const current = await refreshPersistedInstalledPluginIndexWithReceipt({
          reason: "source-changed",
          env: state.env,
          config,
          installRecords: f.current,
          sourceSnapshots: [
            {
              pluginId: "fixture",
              installOwner: "fixture",
              rootDir: f.latest.packageDir,
              descriptor: descriptor(f.latest, 3),
            },
          ],
        });
        const latestDescriptor = {
          ...descriptor(f.latest, 3),
          installedRevision: current.revision,
        };
        const originalDescriptor = descriptor(mode === "same-record" ? f.latest : f.original, 1);
        const metadata = (
          installed: typeof f.original,
          sourceSnapshot: PluginSourceSnapshotDescriptor,
        ) => ({
          installOwner: "fixture",
          rootDir: installed.packageDir,
          installRecordHash: recordHash(installed.record),
          sourceSnapshot,
        });
        const middleDescriptor = descriptor(f.middle, 2);
        f.cohort.publications =
          mode === "same-record"
            ? [
                {
                  kind: "records",
                  records: [],
                  sourceSnapshots: [
                    {
                      pluginId: "fixture",
                      before: metadata(f.latest, originalDescriptor),
                      after: metadata(f.latest, latestDescriptor),
                    },
                  ],
                },
              ]
            : [
                {
                  kind: "records",
                  records: [
                    { pluginId: "fixture", before: f.original.record, after: f.middle.record },
                  ],
                  sourceSnapshots: [
                    {
                      pluginId: "fixture",
                      before: metadata(f.original, originalDescriptor),
                      after: metadata(f.middle, middleDescriptor),
                    },
                  ],
                },
                {
                  kind: "records",
                  records: [
                    { pluginId: "fixture", before: f.middle.record, after: f.latest.record },
                  ],
                  sourceSnapshots: [
                    {
                      pluginId: "fixture",
                      before: metadata(f.middle, middleDescriptor),
                      after: metadata(f.latest, latestDescriptor),
                    },
                  ],
                },
              ];
        expect(await recoveryStore.canCollectPluginSourceSnapshots({ env: state.env })).toBe(true);
        f.begin();
        expect(await recoveryStore.canCollectPluginSourceSnapshots({ env: state.env })).toBe(false);
        if (mode === "successor") {
          await refreshPersistedInstalledPluginIndexWithReceipt({
            reason: "source-changed",
            env: state.env,
            config,
            installRecords: f.current,
            sourceSnapshots: [
              {
                pluginId: "fixture",
                installOwner: "fixture",
                rootDir: f.latest.packageDir,
                descriptor: { ...latestDescriptor, generation: "independent" },
              },
            ],
          });
          await expect(f.settle()).rejects.toThrow("source snapshot changed after the update");
          expect(
            (await readPersistedInstalledPluginIndex({ env: state.env }))?.plugins.find(
              (plugin) => plugin.pluginId === "fixture",
            )?.sourceSnapshot,
          ).toMatchObject({ generation: "independent" });
        } else {
          await f.settle();
          expect(
            (await readPersistedInstalledPluginIndex({ env: state.env }))?.plugins.find(
              (plugin) => plugin.pluginId === "fixture",
            )?.sourceSnapshot,
          ).toEqual(originalDescriptor);
          expect(await recoveryStore.canCollectPluginSourceSnapshots({ env: state.env })).toBe(
            true,
          );
        }
      },
    );
  },
);

it.each(["record", "artifact", "chain"] as const)(
  "preserves a conflicting %s before cumulative index restore",
  async (conflict) => {
    await withOpenClawTestState(
      { label: "cohort-conflicting-records", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const f = await fixture(state);
        if (conflict === "chain") {
          f.cohort.publications[1] = {
            kind: "records",
            records: [
              {
                pluginId: "fixture",
                before: { ...f.middle.record, version: "independent" },
                after: f.latest.record,
              },
            ],
          };
        }
        f.begin();
        const current =
          conflict === "record"
            ? { fixture: { ...f.latest.record, version: "independent" }, later: f.later }
            : f.current;
        if (conflict === "record") {
          await seedInstalledPluginIndex(current, { config, env: state.env });
        }
        if (conflict === "artifact") {
          fs.appendFileSync(path.join(f.latest.packageDir, "package.json"), "\n");
        }
        const commit = vi.spyOn(recordCommit, "commitPluginInstallRecordsOnly");
        await expect(f.settle()).rejects.toThrow(
          conflict === "artifact"
            ? "artifact changed"
            : conflict === "chain"
              ? "between update publications"
              : "changed after the update",
        );
        expect(commit).not.toHaveBeenCalled();
        expect(
          await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
        ).toEqual(current);
        expect(recoveryStore.loadPluginCohortRecovery(f.runId, { env: state.env })).toBeDefined();
      },
    );
  },
);

it("retires an inactive intermediate generation instead of making it discoverable after rollback", async () => {
  await withOpenClawTestState(
    { label: "cohort-intermediate-retention", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const f = await fixture(state);
      f.begin();
      await withPluginCohortConfigCapture(
        {
          runId: f.runId,
          installKey: f.cohort.installKey,
          env: state.env,
          assertCurrent: () => fence.assertCurrent(),
        },
        async () => {
          const context = pluginCohortPublicationContext.getStore();
          if (!context) {
            throw new Error("Plugin cohort capture is missing");
          }
          await markRetainedManagedNpmInstall({
            packageDir: f.middle.packageDir,
            pluginId: "fixture",
            reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
            beforeWrite: (contents) =>
              recordPluginCohortRetentionMarker(context, f.middle.packageDir, contents),
          });
        },
      );
      await f.settle();
      await f.settle();
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual({
        fixture: f.original.record,
        later: f.later,
      });
      expect(
        JSON.parse(
          fs.readFileSync(resolveRetainedManagedNpmInstallMarkerPath(f.middle.packageDir), "utf8"),
        ).reason,
      ).toBe("replaced-by-managed-npm-generation-update");
    },
  );
});

it("reopens a cohort after tentative index publication and owned config compensation", async () => {
  await withOpenClawTestState(
    { label: "cohort-index-compensation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const f = await fixture(state);
      f.begin();
      const refusal = new Error("configuration publication refused");
      await withPluginCohortConfigCapture(
        {
          runId: f.runId,
          installKey: f.cohort.installKey,
          env: state.env,
          assertCurrent: () => fence.assertCurrent(),
        },
        async () => {
          await expect(
            recordCommit.commitPluginInstallRecordsWithConfig({
              previousInstallRecords: f.current,
              nextInstallRecords: { ...f.current, fixture: f.middle.record },
              nextConfig: { ...config, gateway: { mode: "local" } },
              writeOptions: {
                beforeCommit: () => {
                  throw refusal;
                },
              },
            }),
          ).rejects.toBe(refusal);
        },
      );
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual(f.current);
      const publications = recoveryStore
        .loadPluginCohortRecovery(f.runId, { env: state.env })
        ?.cohort.publications.filter((publication) => publication.kind === "records");
      expect(publications?.slice(-2)).toEqual([
        {
          kind: "records",
          records: [{ pluginId: "fixture", before: f.latest.record, after: f.middle.record }],
        },
        {
          kind: "records",
          records: [{ pluginId: "fixture", before: f.middle.record, after: f.latest.record }],
        },
      ]);
      await closeOpenClawStateDatabaseAsync();
      await f.settle();
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual({
        fixture: f.original.record,
        later: f.later,
      });
      expect(recoveryStore.loadPluginCohortRecovery(f.runId, { env: state.env })).toBeUndefined();
    },
  );
});

it("restores valid install records when the prior index metadata requires regeneration", async () => {
  await withOpenClawTestState(
    { label: "cohort-index-metadata", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const f = await fixture(state);
      f.begin();
      writeConfigMachineState(
        INSTALLED_PLUGIN_INDEX_STATE_KEY,
        { revision: 1, index: { version: 999, installRecords: f.current } },
        { env: state.env },
      );
      await withPluginCohortConfigCapture(
        {
          runId: f.runId,
          installKey: f.cohort.installKey,
          env: state.env,
          assertCurrent: () => fence.assertCurrent(),
        },
        () =>
          withPluginLifecycleLeaseAsync({ env: state.env }, (lease) =>
            writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { ...f.current, fixture: f.middle.record },
              { config, env: state.env, lease },
            ),
          ),
      );
      await closeOpenClawStateDatabaseAsync();
      await f.settle();
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual({
        fixture: f.original.record,
        later: f.later,
      });
      expect(recoveryStore.loadPluginCohortRecovery(f.runId, { env: state.env })).toBeUndefined();
    },
  );
});

it("journals owned index-row deletion before reopening cumulative cohort recovery", async () => {
  await withOpenClawTestState(
    { label: "cohort-index-deletion", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const f = await fixture(state);
      f.begin();
      await withPluginCohortConfigCapture(
        {
          runId: f.runId,
          installKey: f.cohort.installKey,
          env: state.env,
          assertCurrent: () => fence.assertCurrent(),
        },
        () =>
          withPluginLifecycleLeaseAsync({ env: state.env }, async (lease) => {
            const receipt = await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              f.current,
              { config, env: state.env, lease },
            );
            expect(
              await restorePersistedInstalledPluginIndexIfCurrent(null, receipt.revision, {
                env: state.env,
                lease,
              }),
            ).toBe(true);
          }),
      );
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toBeNull();
      const publications = recoveryStore
        .loadPluginCohortRecovery(f.runId, { env: state.env })
        ?.cohort.publications.filter((publication) => publication.kind === "records");
      expect(publications?.at(-1)).toEqual({
        kind: "records",
        records: [
          { pluginId: "fixture", before: f.latest.record },
          { pluginId: "later", before: f.later },
        ],
      });
      await closeOpenClawStateDatabaseAsync();
      await f.settle();
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual({
        fixture: f.original.record,
        later: f.later,
      });
      expect(recoveryStore.loadPluginCohortRecovery(f.runId, { env: state.env })).toBeUndefined();
    },
  );
});

it.each(["replacement-active", "database-restored", "later-payload"] as const)(
  "preserves an originally missing npm payload baseline (%s)",
  async (stateAtRecovery) => {
    await withOpenClawTestState(
      { label: "cohort-original-absence", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        await state.writeConfig(config);
        const original = generation(state, "1.0.0");
        await seedInstalledPluginIndex({ fixture: original.record }, { config, env: state.env });
        fs.rmSync(original.npmRoot, { recursive: true });
        const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const pair = await beginUpdatePluginCohort({
          runId,
          installKey: state.root,
          env: state.env,
          fence,
          from: {
            root: state.root,
            nodePath: process.execPath,
            version: "2026.10.9",
            buildId: "old",
          },
          to: {
            root: state.root,
            nodePath: process.execPath,
            version: "2026.10.10",
            buildId: "new",
          },
        });
        expect(pair.cohort.priorArtifacts).toEqual([
          {
            pluginId: "fixture",
            packageDir: original.packageDir,
            record: original.record,
            identity: null,
            markerBefore: null,
            markerAfter: null,
          },
        ]);
        const repaired = generation(state, "2.0.0");
        await markRetainedManagedNpmInstall({
          packageDir: repaired.packageDir,
          pluginId: "fixture",
          reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
        });
        const markerPath = resolveRetainedManagedNpmInstallMarkerPath(repaired.packageDir);
        recoveryStore.writePluginCohortRecovery(
          pair,
          {
            ...pair.cohort,
            artifacts: [
              {
                pluginId: "fixture",
                packageName,
                targetNpmRoot: repaired.npmRoot,
                targetPackageDir: repaired.packageDir,
                stagedIdentity: repaired.identity,
                identity: repaired.identity,
                markerAfter: fs.readFileSync(markerPath, "utf8"),
              },
            ],
            publications: [
              {
                kind: "records",
                records: [{ pluginId: "fixture", before: original.record, after: repaired.record }],
              },
            ],
          },
          fence,
          { env: state.env },
        );
        const current = stateAtRecovery === "database-restored" ? original.record : repaired.record;
        await seedInstalledPluginIndex({ fixture: current }, { config, env: state.env });
        if (stateAtRecovery === "later-payload") {
          fs.mkdirSync(original.packageDir, { recursive: true });
          fs.writeFileSync(
            path.join(original.packageDir, "package.json"),
            '{"version":"independent"}',
          );
          await expect(
            settleUpdatePluginCohort({ runId, env: state.env, fence, action: "rollback" }),
          ).rejects.toThrow("Originally absent payload now exists");
          expect(
            await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
          ).toEqual({
            fixture: repaired.record,
          });
          expect(fs.readFileSync(path.join(original.packageDir, "package.json"), "utf8")).toBe(
            '{"version":"independent"}',
          );
          expect(recoveryStore.loadPluginCohortRecovery(runId, { env: state.env })).toBeDefined();
        } else {
          await settleUpdatePluginCohort({ runId, env: state.env, fence, action: "rollback" });
          expect(
            await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
          ).toEqual({
            fixture: original.record,
          });
          expect(fs.existsSync(original.packageDir)).toBe(false);
          expect(JSON.parse(fs.readFileSync(markerPath, "utf8")).reason).toBe(
            "replaced-by-managed-npm-generation-update",
          );
          expect(recoveryStore.loadPluginCohortRecovery(runId, { env: state.env })).toBeUndefined();
        }
      },
    );
  },
);

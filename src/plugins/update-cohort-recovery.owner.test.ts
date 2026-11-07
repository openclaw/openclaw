import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { getUpdateRun, createUpdateRun } from "../infra/update-run-ledger.js";
import * as recoveryStore from "../infra/update-run-recovery-store.js";
import { updateRunWarningMessages } from "../infra/update-run-step.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "./installed-plugin-index-records.js";
import { refreshPersistedInstalledPluginIndexWithReceipt } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { readPluginCohortPublishedArtifactIdentity } from "./update-cohort-artifacts.js";
import { settleUpdatePluginCohort } from "./update-cohort-recovery.js";
import { config, fence, generation, packageName } from "./update-cohort-recovery.test-support.js";

// Install records are keyed by installation owner; snapshots by plugin ID.
afterEach(() => vi.restoreAllMocks());

it.each(["install record", "source snapshot"] as const)(
  "keeps a later installation %s together with its plugin's other state",
  async (laterChange) => {
    await withOpenClawTestState(
      { label: "cohort-owner-key", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        await state.writeConfig(config);
        // Install records are keyed by installation owner; snapshots by plugin ID.
        const original = generation(state, "1.0.0", "demo");
        const latest = generation(state, "2.0.0", "demo");
        const digests = { contentDigest: "c".repeat(64), dependencyClosureDigest: "d".repeat(64) };
        for (const installed of [original, latest]) {
          installed.record.sourceSnapshotDigests = { demo: digests };
        }
        const descriptor = (installed: typeof original): PluginSourceSnapshotDescriptor => ({
          formatVersion: 1,
          generation: installed.record.version!,
          installedRevision: 1,
          installRecordHash: hashJson(
            normalizeInstallRecordMap({ "package-owner": installed.record })["package-owner"],
          ),
          ...digests,
          buildResolutionDigest: "b".repeat(64),
          platform: process.platform,
          arch: process.arch,
          abi: process.versions.modules,
          artifact: {
            path: state.statePath("snapshot", installed.record.version!),
            identity: "identity",
            manifestIdentity: "manifest",
            manifestDigest: "f".repeat(64),
            tokenIdentity: "token-identity",
          },
        });
        const published = await refreshPersistedInstalledPluginIndexWithReceipt({
          reason: "source-changed",
          env: state.env,
          config,
          installRecords: { "package-owner": latest.record },
          sourceSnapshots: [
            {
              pluginId: "demo",
              installOwner: "package-owner",
              rootDir: latest.packageDir,
              descriptor: descriptor(latest),
            },
          ],
        });
        const snapshot = (installed: typeof original, installedRevision: number) => ({
          installOwner: "package-owner",
          rootDir: installed.packageDir,
          installRecordHash: descriptor(installed).installRecordHash,
          sourceSnapshot: { ...descriptor(installed), installedRevision },
        });
        const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const transactionId = randomUUID();
        recoveryStore.beginPluginCohortRecovery(
          {
            runId,
            transactionId,
            revision: 0,
            claimId: randomUUID(),
            claimKind: "initial",
            handoff: null,
            source: { stateDir: state.stateDir, configPath: state.configPath },
            from: { root: state.root, nodePath: process.execPath, version: "1", buildId: "old" },
            to: { root: state.root, nodePath: process.execPath, version: "2", buildId: "new" },
            createdAtMs: 1,
            updatedAtMs: 1,
            effects: [],
            restore: null,
            verification: null,
            primaryFailure: null,
          },
          {
            runId,
            transactionId,
            revision: 0,
            disposition: "pending",
            installKey: state.root,
            // Both payloads are intact, so only the later state can stop the restore.
            priorArtifacts: [
              {
                pluginId: "package-owner",
                packageDir: original.packageDir,
                record: original.record,
                identity: original.identity,
                markerBefore: null,
                markerAfter: null,
              },
            ],
            artifacts: [
              {
                pluginId: "package-owner",
                packageName,
                targetNpmRoot: latest.npmRoot,
                targetPackageDir: latest.packageDir,
                stagedIdentity: latest.identity,
                identity: latest.identity,
              },
            ],
            publications: [
              {
                kind: "records",
                records: [
                  { pluginId: "package-owner", before: original.record, after: latest.record },
                ],
                sourceSnapshots: [
                  {
                    pluginId: "demo",
                    before: snapshot(original, 1),
                    after: snapshot(latest, published.revision),
                  },
                ],
              },
            ],
            settledPublications: 0,
          },
          fence,
          { env: state.env },
        );
        // A later writer replaced the installation, or only refreshed demo's snapshot.
        const current =
          laterChange === "install record"
            ? { ...latest.record, version: "independent" }
            : latest.record;
        if (laterChange === "install record") {
          await seedInstalledPluginIndex({ "package-owner": current }, { config, env: state.env });
        } else {
          await refreshPersistedInstalledPluginIndexWithReceipt({
            reason: "source-changed",
            env: state.env,
            config,
            installRecords: { "package-owner": current },
            sourceSnapshots: [
              {
                pluginId: "demo",
                installOwner: "package-owner",
                rootDir: latest.packageDir,
                descriptor: { ...descriptor(latest), generation: "independent" },
              },
            ],
          });
        }
        await settleUpdatePluginCohort({ runId, env: state.env, fence, action: "rollback" });
        expect(
          await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
        ).toEqual({ "package-owner": current });
        expect(recoveryStore.loadPluginCohortRecovery(runId, { env: state.env })).toBeUndefined();
        expect(
          updateRunWarningMessages(getUpdateRun(runId, { env: state.env })?.steps ?? []),
        ).toEqual([
          expect.stringContaining(
            laterChange === "install record"
              ? "plugin package-owner install record"
              : "plugin demo source snapshot",
          ),
        ]);
      },
    );
  },
);

it("keeps every plugin snapshot of an installation when one of them changed later", async () => {
  await withOpenClawTestState(
    { label: "cohort-owner-pack", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      await state.writeConfig(config);
      const plugins = ["pack/a", "pack/b"];
      const digests = { contentDigest: "c".repeat(64), dependencyClosureDigest: "d".repeat(64) };
      // One npm installation that exposes two plugins.
      const pack = (version: string) => {
        const installed = generation(state, version, "pack");
        const manifest = path.join(installed.packageDir, "package.json");
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        pkg.openclaw.extensions = ["./dist/a.js", "./dist/b.js"];
        fs.writeFileSync(manifest, JSON.stringify(pkg));
        for (const entry of ["a", "b"]) {
          fs.writeFileSync(path.join(installed.packageDir, "dist", `${entry}.js`), "export {};\n");
        }
        installed.record.sourceSnapshotDigests = Object.fromEntries(
          plugins.map((pluginId) => [pluginId, digests]),
        );
        return {
          ...installed,
          identity: readPluginCohortPublishedArtifactIdentity(installed.packageDir),
        };
      };
      const original = pack("1.0.0");
      const latest = pack("2.0.0");
      const recordHash = (installed: typeof original) =>
        hashJson(normalizeInstallRecordMap({ "package-owner": installed.record })["package-owner"]);
      const descriptor = (
        installed: typeof original,
        generationLabel = installed.record.version!,
      ): PluginSourceSnapshotDescriptor => ({
        formatVersion: 1,
        generation: generationLabel,
        installedRevision: 1,
        installRecordHash: recordHash(installed),
        ...digests,
        buildResolutionDigest: "b".repeat(64),
        platform: process.platform,
        arch: process.arch,
        abi: process.versions.modules,
        artifact: {
          path: state.statePath("snapshot", generationLabel),
          identity: "identity",
          manifestIdentity: "manifest",
          manifestDigest: "f".repeat(64),
          tokenIdentity: "token-identity",
        },
      });
      const publish = (pluginIds: readonly string[], generationLabel?: string) =>
        refreshPersistedInstalledPluginIndexWithReceipt({
          reason: "source-changed",
          env: state.env,
          config,
          installRecords: { "package-owner": latest.record },
          sourceSnapshots: pluginIds.map((pluginId) => ({
            pluginId,
            installOwner: "package-owner",
            rootDir: latest.packageDir,
            descriptor: descriptor(latest, generationLabel),
          })),
        });
      const published = await publish(plugins);
      const snapshot = (installed: typeof original, installedRevision: number) => ({
        installOwner: "package-owner",
        rootDir: installed.packageDir,
        installRecordHash: recordHash(installed),
        sourceSnapshot: { ...descriptor(installed), installedRevision },
      });
      const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const transactionId = randomUUID();
      recoveryStore.beginPluginCohortRecovery(
        {
          runId,
          transactionId,
          revision: 0,
          claimId: randomUUID(),
          claimKind: "initial",
          handoff: null,
          source: { stateDir: state.stateDir, configPath: state.configPath },
          from: { root: state.root, nodePath: process.execPath, version: "1", buildId: "old" },
          to: { root: state.root, nodePath: process.execPath, version: "2", buildId: "new" },
          createdAtMs: 1,
          updatedAtMs: 1,
          effects: [],
          restore: null,
          verification: null,
          primaryFailure: null,
        },
        {
          runId,
          transactionId,
          revision: 0,
          disposition: "pending",
          installKey: state.root,
          priorArtifacts: [
            {
              pluginId: "package-owner",
              packageDir: original.packageDir,
              record: original.record,
              identity: original.identity,
              markerBefore: null,
              markerAfter: null,
            },
          ],
          artifacts: [
            {
              pluginId: "package-owner",
              packageName,
              targetNpmRoot: latest.npmRoot,
              targetPackageDir: latest.packageDir,
              stagedIdentity: latest.identity,
              identity: latest.identity,
            },
          ],
          publications: [
            {
              kind: "records",
              records: [
                { pluginId: "package-owner", before: original.record, after: latest.record },
              ],
              sourceSnapshots: plugins.map((pluginId) => ({
                pluginId,
                before: snapshot(original, 1),
                after: snapshot(latest, published.revision),
              })),
            },
          ],
          settledPublications: 0,
        },
        fence,
        { env: state.env },
      );
      // Only pack/a's snapshot is refreshed later; the installation keeps both plugins.
      await publish(["pack/a"], "independent");
      await settleUpdatePluginCohort({ runId, env: state.env, fence, action: "rollback" });
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual({ "package-owner": latest.record });
      const generations = Object.fromEntries(
        ((await readPersistedInstalledPluginIndex({ env: state.env }))?.plugins ?? []).map(
          (plugin) => [
            plugin.pluginId,
            (plugin.sourceSnapshot as Partial<PluginSourceSnapshotDescriptor> | undefined)
              ?.generation,
          ],
        ),
      );
      expect(generations).toEqual({ "pack/a": "independent", "pack/b": "2.0.0" });
      expect(recoveryStore.loadPluginCohortRecovery(runId, { env: state.env })).toBeUndefined();
      expect(
        updateRunWarningMessages(getUpdateRun(runId, { env: state.env })?.steps ?? []),
      ).toEqual([expect.stringContaining("plugin pack/a source snapshot")]);
    },
  );
});

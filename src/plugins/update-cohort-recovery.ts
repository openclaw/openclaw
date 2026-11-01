import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import {
  copyPluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { hasErrnoCode } from "../infra/errno.js";
import type { PluginCohortPublicationContext } from "../infra/update-plugin-cohort-context.js";
import { foldPluginCohortRecordPublications } from "../infra/update-plugin-cohort-records.js";
import type {
  PluginCohortRecovery,
  PluginCohortRecoveryPair,
} from "../infra/update-plugin-cohort-schema.js";
import type { UpdateRecoveryRecord } from "../infra/update-run-recovery-schema.js";
import {
  beginPluginCohortRecovery,
  deletePluginCohortRecovery,
  loadPluginCohortRecovery,
  writePluginCohortRecovery,
} from "../infra/update-run-recovery-store.js";
import type { UpdateRecoveryFence } from "../infra/update-run-recovery-types.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { assertSupportedStateSchemaVersion } from "../state/openclaw-state-db-schema-version.js";
import { commitPluginInstallRecordsOnly } from "./install-record-commit.js";
import type { PluginCohortInstallObserver } from "./install-transaction.js";
import {
  inspectPersistedInstalledPluginIndexInstallRecords,
  preparePersistedInstalledPluginIndexCacheEntry,
} from "./installed-plugin-index-record-state.js";
import { withoutPluginInstallRecords } from "./installed-plugin-index-records.js";
import { foldPluginSourceSnapshotChanges } from "./installed-plugin-index-source-snapshots.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  clearRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
  restoreRetainedManagedNpmInstallMarkers,
} from "./managed-npm-retention.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  assertPluginCohortArtifactDirectory,
  readPluginCohortArtifactIdentity as artifactIdentity,
  readPluginCohortArtifactPreimage,
  ownsPluginCohortRetentionMarker as ownsRetentionMarker,
  readPluginCohortRetentionMarker,
} from "./update-cohort-artifacts.js";

type ArtifactIdentity = NonNullable<PluginCohortRecovery["priorArtifacts"][number]["identity"]>;
type CohortOptions = { env: NodeJS.ProcessEnv; fence: UpdateRecoveryFence };

/** Rollback compares ledger publications, never a projection recovered from package bytes. */
async function readCohortInstallRecords(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, PluginInstallRecord>> {
  const prepared = await preparePersistedInstalledPluginIndexCacheEntry({ env });
  prepared.assertCurrent();
  const state = inspectPersistedInstalledPluginIndexInstallRecords(prepared.entry);
  if (state.status === "invalid") {
    throw new Error("Plugin cohort recovery cannot compare invalid canonical install records.");
  }
  return state.status === "valid" ? state.records : {};
}

async function readMarker(packageDir: string): Promise<string | null> {
  try {
    return await fs.readFile(resolveRetainedManagedNpmInstallMarkerPath(packageDir), "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function assertArtifact(
  packageDir: string,
  expected: ArtifactIdentity | null,
): Promise<void> {
  if (expected === null) {
    try {
      await fs.lstat(packageDir);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    throw new Error(
      `Plugin cohort artifact changed: ${packageDir}. Originally absent payload now exists.`,
    );
  }
  if (!isDeepStrictEqual(artifactIdentity(packageDir), expected)) {
    throw new Error(
      `Plugin cohort artifact changed: ${packageDir}. Retained recovery was left intact.`,
    );
  }
}

function artifactMutationGuard(
  packageDir: string,
  identity: ArtifactIdentity,
  fence: UpdateRecoveryFence,
): () => void {
  return () => {
    fence.assertCurrent();
    assertPluginCohortArtifactDirectory(packageDir, identity);
  };
}

function assertSource(pair: PluginCohortRecoveryPair, options: CohortOptions): void {
  options.fence.assertCurrent();
  const source = pair.reservation.source;
  if (
    !source ||
    resolveStateDir(options.env) !== source.stateDir ||
    resolveConfigPath(options.env, source.stateDir) !== source.configPath
  ) {
    throw new Error("Plugin cohort recovery state or configuration path changed.");
  }
}

/** Captured after the database backup, before candidate Doctor can mutate plugins. */
export async function beginUpdatePluginCohort(
  params: CohortOptions & {
    runId: string;
    installKey: string;
    from: UpdateRecoveryRecord["from"];
    to: UpdateRecoveryRecord["to"];
  },
): Promise<PluginCohortRecoveryPair> {
  return await withPluginLifecycleLease(
    { env: params.env, assertCurrent: params.fence.assertCurrent },
    async (lease) => {
      const fence = {
        assertCurrent: () => {
          params.fence.assertCurrent();
          lease.assertOwned();
        },
      };
      const options = { ...params, fence };
      const existing = loadPluginCohortRecovery(params.runId, { env: params.env });
      if (existing) {
        assertSource(existing, options);
        if (
          existing.cohort.installKey !== params.installKey ||
          !isDeepStrictEqual(existing.reservation.from, params.from) ||
          !isDeepStrictEqual(existing.reservation.to, params.to)
        ) {
          throw new Error("Plugin cohort recovery belongs to a different core activation.");
        }
        return existing;
      }
      const records = await readCohortInstallRecords(params.env);
      const priorArtifacts: PluginCohortRecovery["priorArtifacts"] = [];
      for (const [pluginId, record] of Object.entries(records)) {
        if (record.source !== "npm" || !record.installPath) {
          continue;
        }
        const identity = readPluginCohortArtifactPreimage(record.installPath);
        priorArtifacts.push({
          pluginId,
          packageDir: record.installPath,
          record,
          identity,
          markerBefore:
            identity === null
              ? null
              : readPluginCohortRetentionMarker(record.installPath, params.env),
          markerAfter: null,
        });
      }
      fence.assertCurrent();
      const now = Date.now();
      const stateDir = resolveStateDir(params.env);
      const transactionId = randomUUID();
      let pair = beginPluginCohortRecovery(
        {
          runId: params.runId,
          transactionId,
          revision: 0,
          claimId: randomUUID(),
          claimKind: "initial",
          handoff: null,
          source: {
            stateDir,
            configPath: resolveConfigPath(params.env, stateDir),
            profile: params.env.OPENCLAW_PROFILE ?? null,
          },
          from: params.from,
          to: params.to,
          createdAtMs: now,
          updatedAtMs: now,
          effects: [],
          restore: null,
          verification: null,
          primaryFailure: null,
        },
        {
          runId: params.runId,
          transactionId,
          revision: 0,
          disposition: "pending",
          installKey: params.installKey,
          priorArtifacts,
          artifacts: [],
          publications: [],
          settledPublications: 0,
        },
        fence,
        { env: params.env },
      );
      for (const [index, artifact] of priorArtifacts.entries()) {
        if (artifact.identity === null || !ownsRetentionMarker(artifact.packageDir, params.env)) {
          continue;
        }
        await assertArtifact(artifact.packageDir, artifact.identity);
        await markRetainedManagedNpmInstall({
          packageDir: artifact.packageDir,
          pluginId: artifact.pluginId,
          reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
          assertCurrent: artifactMutationGuard(artifact.packageDir, artifact.identity, fence),
          beforeWrite: (contents) => {
            const next = pair.cohort.priorArtifacts.map((entry, entryIndex) =>
              entryIndex === index ? { ...entry, markerAfter: contents } : entry,
            );
            pair = writePluginCohortRecovery(
              pair,
              { ...pair.cohort, priorArtifacts: next },
              fence,
              { env: params.env },
            );
          },
        });
      }
      return pair;
    },
  );
}

/** Reopening records facts under a new live lease; it never revives install closures. */
export function createPluginCohortPublication(
  params: CohortOptions & { runId: string; deferRecordPublication?: true },
) {
  let pair = loadPluginCohortRecovery(params.runId, { env: params.env });
  if (!pair) {
    return undefined;
  }
  assertSource(pair, params);
  if (pair.cohort.disposition !== "pending") {
    throw new Error("Plugin cohort settlement must finish before installing more packages.");
  }
  const write = (artifacts: PluginCohortRecovery["artifacts"]) => {
    const current = loadPluginCohortRecovery(params.runId, { env: params.env });
    if (!current) {
      throw new Error("Plugin cohort recovery disappeared before artifact publication.");
    }
    assertSource(current, params);
    pair = writePluginCohortRecovery(current, { ...current.cohort, artifacts }, params.fence, {
      env: params.env,
    });
  };
  const observer: PluginCohortInstallObserver = {
    forceFreshGeneration: true,
    deferRecordPublication: params.deferRecordPublication,
    async beforeManagedNpmPublish(facts) {
      const stagedIdentity = artifactIdentity(facts.stagedPackageDir);
      assertSource(pair!, params);
      write([
        ...pair!.cohort.artifacts,
        {
          pluginId: facts.pluginId,
          packageName: facts.packageName,
          targetNpmRoot: facts.targetNpmRoot,
          targetPackageDir: facts.targetPackageDir,
          stagedIdentity,
        },
      ]);
      // The fresh generation stays undiscoverable if the updater dies before publishing its index.
      await markRetainedManagedNpmInstall({
        packageDir: facts.stagedPackageDir,
        pluginId: facts.pluginId,
        reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
        assertCurrent: artifactMutationGuard(facts.stagedPackageDir, stagedIdentity, params.fence),
        beforeWrite: (contents) => {
          write(
            pair!.cohort.artifacts.map((artifact) =>
              artifact.targetPackageDir === facts.targetPackageDir
                ? Object.assign({}, artifact, { markerAfter: contents })
                : artifact,
            ),
          );
        },
      });
    },
  };
  return {
    observer,
    async beforePublication() {
      const artifacts = pair!.cohort.artifacts.map((artifact) => {
        try {
          return Object.assign({}, artifact, {
            identity: artifactIdentity(artifact.targetPackageDir),
          });
        } catch (error) {
          if (hasErrnoCode(error, "ENOENT")) {
            return artifact;
          }
          throw error;
        }
      });
      assertSource(pair!, params);
      write(artifacts);
    },
  };
}

/** The index owner already captured this displaced generation before making it inactive. */
export function recordPluginCohortRetentionMarker(
  context: PluginCohortPublicationContext,
  packageDir: string,
  contents: string,
): void {
  const pair = loadPluginCohortRecovery(context.runId, { env: context.env });
  if (
    !pair ||
    pair.cohort.transactionId !== context.transactionId ||
    pair.cohort.installKey !== context.installKey ||
    pair.cohort.disposition !== "pending"
  ) {
    throw new Error("Plugin retention marker lost its owning update cohort.");
  }
  assertSource(pair, { env: context.env, fence: context });
  const priorArtifacts = pair.cohort.priorArtifacts.map((artifact) => {
    if (artifact.packageDir !== packageDir) {
      return artifact;
    }
    if (!isDeepStrictEqual(artifactIdentity(packageDir), artifact.identity)) {
      throw new Error("Plugin retention artifact changed before protection.");
    }
    return { ...artifact, markerAfter: contents };
  });
  if (!priorArtifacts.some((artifact) => artifact.packageDir === packageDir)) {
    throw new Error("Plugin retention artifact has no recorded preimage.");
  }
  writePluginCohortRecovery(pair, { ...pair.cohort, priorArtifacts }, context, {
    env: context.env,
  });
}

/** Restore only matching cohort deltas. A later writer keeps its values and blocks old-core readiness. */
export async function settleUpdatePluginCohort(
  params: CohortOptions & { runId: string; action: "commit" | "rollback" },
): Promise<{ configPaths: string[] }> {
  params.fence.assertCurrent();
  // A cold candidate must not migrate a database just restored for its older core.
  // The canonical reader still rejects newer content before selecting the stable lease subset.
  const schemaPolicy = withOpenClawStateDatabaseReadOnly<"existing" | undefined>(
    ({ db, path }) =>
      assertSupportedStateSchemaVersion(db, path) < OPENCLAW_STATE_SCHEMA_VERSION
        ? "existing"
        : undefined,
    { env: params.env },
  );
  params.fence.assertCurrent();
  return await withPluginLifecycleLease(
    { env: params.env, schemaPolicy, assertCurrent: params.fence.assertCurrent },
    async (lease) => {
      const fence = {
        assertCurrent: () => {
          params.fence.assertCurrent();
          lease.assertOwned();
        },
      };
      let pair = loadPluginCohortRecovery(params.runId, { env: params.env });
      if (!pair) {
        return { configPaths: [] };
      }
      const options = { ...params, fence };
      const configPaths = pair.cohort.publications.flatMap((publication) =>
        publication.kind === "config" ? [publication.file.filePath] : [],
      );
      assertSource(pair, options);
      if (pair.cohort.disposition !== "pending" && pair.cohort.disposition !== params.action) {
        throw new Error("Plugin cohort already selected a different settlement.");
      }
      pair = writePluginCohortRecovery(
        pair,
        { ...pair.cohort, disposition: params.action },
        fence,
        { env: params.env },
      );
      if (params.action === "rollback") {
        const recordChanges = foldPluginCohortRecordPublications(pair.cohort.publications);
        const sourceSnapshotRestorations = foldPluginSourceSnapshotChanges(
          pair.cohort.publications.flatMap((publication) =>
            publication.kind === "records" ? (publication.sourceSnapshots ?? []) : [],
          ),
        );
        const migrations = pair.cohort.publications.filter(
          (publication) => publication.kind === "plugin-migrations",
        );
        if (migrations.length > 0) {
          const { restorePluginCohortMigrationPublications } =
            await import("../infra/deferred-plugin-migrations.js");
          await restorePluginCohortMigrationPublications(migrations, {
            env: params.env,
            assertCurrent: fence.assertCurrent,
          });
        }
        const publications = pair.cohort.publications.toReversed();
        for (let index = pair.cohort.settledPublications; index < publications.length; index++) {
          const publication = publications[index]!;
          if (publication.kind === "config") {
            const { restorePluginCohortConfigPublication } =
              await import("../config/plugin-cohort-recovery.js");
            await restorePluginCohortConfigPublication(publication.file, {
              env: params.env,
              assertCurrent: fence.assertCurrent,
            });
          }
          fence.assertCurrent();
          pair = writePluginCohortRecovery(
            pair,
            { ...pair.cohort, settledPublications: index + 1 },
            fence,
            { env: params.env },
          );
        }
        // Install closures may have removed intermediate fresh generations. Restore
        // each plugin directly to its original record with one atomic index write.
        if (recordChanges.size > 0 || sourceSnapshotRestorations.length > 0) {
          const currentRecords = await readCohortInstallRecords(params.env);
          const nextRecords = copyPluginInstallRecordMap(currentRecords);
          const snapshot = await readConfigFileSnapshot({
            skipPluginValidation: true,
            observe: false,
          });
          if (snapshot.path !== pair.reservation.source?.configPath) {
            throw new Error("Plugin cohort restoration selected a different configuration path.");
          }
          for (const change of recordChanges.values()) {
            const current = currentRecords[change.pluginId];
            const alreadyRestored = isDeepStrictEqual(current, change.before);
            if (!alreadyRestored && !isDeepStrictEqual(current, change.after)) {
              throw new Error(
                `Plugin ${change.pluginId} changed after the update; cohort recovery preserved it.`,
              );
            }
            const before = change.before;
            if (before?.source === "npm" && before.installPath) {
              const beforePath = before.installPath;
              const priorArtifact = pair.cohort.priorArtifacts.find(
                (artifact) =>
                  artifact.pluginId === change.pluginId &&
                  artifact.packageDir === beforePath &&
                  isDeepStrictEqual(artifact.record, before),
              );
              if (!priorArtifact) {
                throw new Error(`Plugin ${change.pluginId} has no matching retained artifact.`);
              }
              await assertArtifact(priorArtifact.packageDir, priorArtifact.identity);
            }
            if (alreadyRestored) {
              continue;
            }
            if (change.after?.source === "npm" && change.after.installPath) {
              const afterPath = change.after.installPath;
              const artifact = pair.cohort.artifacts.find(
                (entry) =>
                  entry.pluginId === change.pluginId && entry.targetPackageDir === afterPath,
              );
              const priorArtifact = pair.cohort.priorArtifacts.find(
                (entry) => entry.pluginId === change.pluginId && entry.packageDir === afterPath,
              );
              if (!artifact && !priorArtifact) {
                throw new Error(`Plugin ${change.pluginId} has no matching published artifact.`);
              }
              let exists = true;
              try {
                await fs.access(afterPath);
              } catch (error) {
                if (!hasErrnoCode(error, "ENOENT")) {
                  throw error;
                }
                // Caught same-scope install rollback may already have removed it.
                exists = false;
              }
              if (exists) {
                const identity = artifact?.identity ?? priorArtifact?.identity;
                if (!identity) {
                  throw new Error(`Plugin ${change.pluginId} has no published artifact identity.`);
                }
                await assertArtifact(afterPath, identity);
              }
            }
            if (change.before) {
              setPluginInstallRecordMapEntry(nextRecords, change.pluginId, change.before);
            } else {
              delete nextRecords[change.pluginId];
            }
          }
          fence.assertCurrent();
          if (
            !isDeepStrictEqual(nextRecords, currentRecords) ||
            sourceSnapshotRestorations.length > 0
          ) {
            await commitPluginInstallRecordsOnly({
              sourceSnapshotRestorations,
              previousInstallRecords: currentRecords,
              nextInstallRecords: nextRecords,
              nextConfig: withoutPluginInstallRecords(snapshot.sourceConfig),
              verifyConfigFresh: async () => {
                const current = await readConfigFileSnapshot({
                  skipPluginValidation: true,
                  observe: false,
                });
                fence.assertCurrent();
                if (current.path !== snapshot.path || current.hash !== snapshot.hash) {
                  throw new Error("Configuration changed during plugin cohort restoration.");
                }
              },
            });
          }
          fence.assertCurrent();
        }
      }
      const records = await readCohortInstallRecords(params.env);
      for (const artifact of pair.cohort.priorArtifacts) {
        if (artifact.identity === null || artifact.markerAfter === null) {
          continue;
        }
        const marker = await readMarker(artifact.packageDir);
        if (marker === artifact.markerBefore) {
          continue;
        }
        // An independent owner may have retained the same directory for another reason.
        if (marker !== artifact.markerAfter) {
          continue;
        }
        await assertArtifact(artifact.packageDir, artifact.identity);
        fence.assertCurrent();
        const active = Object.values(records).some(
          (record) => record.installPath === artifact.packageDir,
        );
        const assertMarkerCurrent = artifactMutationGuard(
          artifact.packageDir,
          artifact.identity,
          fence,
        );
        // Intermediate cohort generations also stay hidden after restoring the original.
        if (!active) {
          await markRetainedManagedNpmInstall({
            packageDir: artifact.packageDir,
            pluginId: artifact.pluginId,
            reason: "replaced-by-managed-npm-generation-update",
            assertCurrent: assertMarkerCurrent,
          });
        } else if (artifact.markerBefore === null) {
          await clearRetainedManagedNpmInstallMarker(artifact.packageDir, assertMarkerCurrent);
        } else {
          await restoreRetainedManagedNpmInstallMarkers({
            clearedMarkerSnapshots: [
              {
                markerPath: resolveRetainedManagedNpmInstallMarkerPath(artifact.packageDir),
                contents: artifact.markerBefore,
              },
            ],
            createdMarkerPaths: [],
            assertCurrent: assertMarkerCurrent,
          });
        }
      }
      // A crash before index publication leaves this generation intentionally
      // undiscoverable. Retire its owned marker so ordinary cleanup can reclaim it.
      for (const artifact of pair.cohort.artifacts) {
        if (
          !artifact.markerAfter ||
          Object.values(records).some((record) => record.installPath === artifact.targetPackageDir)
        ) {
          continue;
        }
        let currentMarker: string | null;
        try {
          currentMarker = await readMarker(artifact.targetPackageDir);
        } catch (error) {
          if (hasErrnoCode(error, "ENOENT")) {
            continue;
          }
          throw error;
        }
        if (currentMarker !== artifact.markerAfter) {
          continue;
        }
        const expected = artifact.identity ?? {
          ...artifact.stagedIdentity,
          realPath: artifact.targetPackageDir,
        };
        await assertArtifact(artifact.targetPackageDir, expected);
        await markRetainedManagedNpmInstall({
          packageDir: artifact.targetPackageDir,
          pluginId: artifact.pluginId,
          reason: "replaced-by-managed-npm-generation-update",
          assertCurrent: artifactMutationGuard(artifact.targetPackageDir, expected, fence),
        });
      }
      fence.assertCurrent();
      deletePluginCohortRecovery(pair, fence, { env: params.env });
      try {
        const { collectInstalledPluginSourceSnapshots } =
          await import("./plugin-source-snapshot-collection.js");
        await collectInstalledPluginSourceSnapshots(resolveStateDir(params.env));
      } catch (error) {
        process.emitWarning(`Plugin source snapshot collection deferred: ${String(error)}`);
      }
      return { configPaths };
    },
  );
}

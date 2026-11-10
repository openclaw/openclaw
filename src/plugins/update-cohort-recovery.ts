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
import {
  foldPluginSourceSnapshotChanges,
  listLaterPluginSourceSnapshotChanges,
} from "./installed-plugin-index-source-snapshots.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  clearRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
  restoreRetainedManagedNpmInstallMarkers,
} from "./managed-npm-retention.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import type { PluginSourceSnapshotIndexChange } from "./plugin-source-snapshot.types.js";
import {
  assertPluginCohortArtifactDirectory,
  readPluginCohortArtifactIdentity as artifactIdentity,
  readPluginCohortArtifactPreimage,
  readPluginCohortPublishedArtifactIdentity as publishedArtifactIdentity,
  ownsPluginCohortRetentionMarker as ownsRetentionMarker,
  readPluginCohortRetentionMarker,
} from "./update-cohort-artifacts.js";
import { formatKeptChanges, recordKeptChanges } from "./update-cohort-kept-changes.js";

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

/** False when a later writer replaced the payload or created an originally absent one. */
async function artifactUnchanged(
  packageDir: string,
  expected: ArtifactIdentity | null,
): Promise<boolean> {
  if (expected === null) {
    try {
      await fs.lstat(packageDir);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }
    return false;
  }
  return isDeepStrictEqual(artifactIdentity(packageDir), expected);
}

async function assertArtifact(
  packageDir: string,
  expected: ArtifactIdentity | null,
): Promise<void> {
  if (!(await artifactUnchanged(packageDir, expected))) {
    throw new Error(
      expected === null
        ? `Plugin cohort artifact changed: ${packageDir}. Originally absent payload now exists.`
        : `Plugin cohort artifact changed: ${packageDir}. Retained recovery was left intact.`,
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

/** Retain plugin preimages before database capture and candidate Doctor mutations. */
export async function beginUpdatePluginCohort(
  params: CohortOptions & {
    runId: string;
    installKey: string;
    from: UpdateRecoveryRecord["from"];
    to: UpdateRecoveryRecord["to"];
  },
): Promise<PluginCohortRecoveryPair> {
  return await withPluginLifecycleLease(
    // Reservation precedes candidate Doctor; lease bookkeeping must not migrate its source.
    { env: params.env, schemaPolicy: "existing", assertCurrent: params.fence.assertCurrent },
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
      const stagedIdentity = publishedArtifactIdentity(facts.stagedPackageDir);
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
            identity: publishedArtifactIdentity(artifact.targetPackageDir),
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

/** Install records are keyed by installation owner; snapshots by plugin ID. */
function snapshotBelongsToInstallation(
  restoration: PluginSourceSnapshotIndexChange,
  installKey: string,
): boolean {
  const owners = [restoration.before?.installOwner, restoration.after?.installOwner].filter(
    (owner) => owner !== undefined,
  );
  return owners.length > 0 ? owners.includes(installKey) : restoration.pluginId === installKey;
}

/**
 * Restore only matching cohort deltas. A migration obligation, install record,
 * source snapshot, package payload or config file that a later writer changed
 * keeps that value; rollback restores the rest, completes, and records what it
 * kept as a warning on the update run.
 */
export async function settleUpdatePluginCohort(
  params: CohortOptions & {
    runId: string;
    action: "commit" | "rollback";
    /** Repair proved the candidate serves; commit over a recorded rollback that restored nothing. */
    supersedeUnsettledRollback?: true;
    onLaterDecisionsKept?: (warning: string) => void;
  },
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
      const migrations = pair.cohort.publications.filter(
        (publication) => publication.kind === "plugin-migrations",
      );
      let action = params.action;
      const supersede =
        params.supersedeUnsettledRollback === true &&
        params.action === "commit" &&
        pair.cohort.disposition === "rollback";
      if (supersede) {
        // Rollback restores migration rows before it counts settled publications.
        // Once it restored anything, only finishing that rollback keeps state consistent.
        const { hasRestoredPluginCohortMigrationPublications } =
          await import("../infra/deferred-plugin-migrations.cohort.js");
        if (
          pair.cohort.settledPublications > 0 ||
          hasRestoredPluginCohortMigrationPublications(migrations, { env: params.env })
        ) {
          action = "rollback";
        }
      }
      if (
        pair.cohort.disposition !== "pending" &&
        pair.cohort.disposition !== action &&
        !supersede
      ) {
        throw new Error("Plugin cohort already selected a different settlement.");
      }
      pair = writePluginCohortRecovery(pair, { ...pair.cohort, disposition: action }, fence, {
        env: params.env,
      });
      const kept: string[] = [];
      if (action === "rollback") {
        const recordChanges = foldPluginCohortRecordPublications(pair.cohort.publications);
        let sourceSnapshotRestorations = foldPluginSourceSnapshotChanges(
          pair.cohort.publications.flatMap((publication) =>
            publication.kind === "records" ? (publication.sourceSnapshots ?? []) : [],
          ),
        );
        if (migrations.length > 0) {
          const { restorePluginCohortMigrationPublications } =
            await import("../infra/deferred-plugin-migrations.js");
          const obligations = await restorePluginCohortMigrationPublications(migrations, {
            env: params.env,
            assertCurrent: fence.assertCurrent,
          });
          kept.push(...obligations.map((id) => `plugin ${id} data/settings upgrade obligation`));
        }
        const publications = pair.cohort.publications.toReversed();
        for (let index = pair.cohort.settledPublications; index < publications.length; index++) {
          const publication = publications[index]!;
          if (publication.kind === "config") {
            const { restorePluginCohortConfigPublication } =
              await import("../config/plugin-cohort-recovery.js");
            const restored = await restorePluginCohortConfigPublication(publication.file, {
              env: params.env,
              assertCurrent: fence.assertCurrent,
            });
            if (!restored) {
              kept.push(`config file ${publication.file.filePath}`);
              // Counting this file below means no later repair revisits it; record it first.
              recordKeptChanges(params.runId, kept, params.env);
            }
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
          // A later writer owns an installation whose record, plugin source snapshot or
          // package files changed after publication. Keep its index state as it is now.
          const keepPlugin = (installKey: string, what: string) => {
            kept.push(`plugin ${installKey} ${what}`);
            sourceSnapshotRestorations = sourceSnapshotRestorations.filter(
              (restoration) => !snapshotBelongsToInstallation(restoration, installKey),
            );
          };
          const laterSnapshots = listLaterPluginSourceSnapshotChanges(
            await readPersistedInstalledPluginIndex({ env: params.env }),
            sourceSnapshotRestorations,
          );
          for (const later of laterSnapshots) {
            kept.push(`plugin ${later.pluginId} source snapshot`);
            sourceSnapshotRestorations = sourceSnapshotRestorations.filter(
              (restoration) => restoration.pluginId !== later.pluginId,
            );
          }
          for (const change of recordChanges.values()) {
            const current = currentRecords[change.pluginId];
            const alreadyRestored = isDeepStrictEqual(current, change.before);
            if (
              laterSnapshots.some((later) => snapshotBelongsToInstallation(later, change.pluginId))
            ) {
              if (!alreadyRestored && !isDeepStrictEqual(current, change.after)) {
                kept.push(`plugin ${change.pluginId} install record`);
              }
              // The kept record still installs this owner's other plugins at their later state.
              sourceSnapshotRestorations = sourceSnapshotRestorations.filter(
                (restoration) => !snapshotBelongsToInstallation(restoration, change.pluginId),
              );
              continue;
            }
            if (!alreadyRestored && !isDeepStrictEqual(current, change.after)) {
              keepPlugin(change.pluginId, "install record");
              continue;
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
              if (
                !priorArtifact ||
                !(await artifactUnchanged(priorArtifact.packageDir, priorArtifact.identity))
              ) {
                keepPlugin(change.pluginId, "original package files");
                continue;
              }
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
                keepPlugin(change.pluginId, "package files");
                continue;
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
              const identity = artifact?.identity ?? priorArtifact?.identity;
              if (exists && (!identity || !(await artifactUnchanged(afterPath, identity)))) {
                keepPlugin(change.pluginId, "package files");
                continue;
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
        if (!(await artifactUnchanged(artifact.packageDir, artifact.identity))) {
          // Leave a later writer's payload and its retention marker untouched.
          kept.push(`plugin ${artifact.pluginId} package files at ${artifact.packageDir}`);
          continue;
        }
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
        const currentMarker = await readMarker(artifact.targetPackageDir);
        if (currentMarker !== artifact.markerAfter) {
          continue;
        }
        const expected = artifact.identity ?? {
          ...artifact.stagedIdentity,
          realPath: artifact.targetPackageDir,
        };
        if (!(await artifactUnchanged(artifact.targetPackageDir, expected))) {
          kept.push(`plugin ${artifact.pluginId} package files at ${artifact.targetPackageDir}`);
          continue;
        }
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
      if (kept.length > 0) {
        let warning: string;
        try {
          warning = recordKeptChanges(params.runId, kept, params.env);
        } catch (error) {
          warning = formatKeptChanges(kept);
          process.emitWarning(
            `Update history did not record kept plugin changes: ${String(error)}`,
          );
        }
        params.onLaterDecisionsKept?.(warning);
      }
      return { configPaths };
    },
  );
}

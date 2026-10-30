/** Retirement of producer-verified originals; never a suffix deletion policy. */
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  statMigrationPath,
  type MigrationArtifact,
  type MigrationArtifactVerification,
} from "../infra/session-sqlite-migration-artifact.js";
import type { DoctorSessionSqliteIssue } from "../infra/session-sqlite-migration-issues.js";
import {
  hasSymbolicLinkInDirectoryPath,
  type SessionSqliteMigrationTargetInput,
} from "../infra/session-sqlite-migration-manifest.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership-preflight.js";
import { collectHistoricalArchiveSources } from "./doctor-session-sqlite-discovery.js";
import {
  assertRecoveryOriginal,
  disposeRecoveryArtifacts,
} from "./doctor-session-sqlite-disposal.js";
import { coalesceSessionSqliteArchiveReferences } from "./doctor-session-sqlite-migration-coalesce.js";
import {
  collectUpdateCleanupInventory,
  protectRecoveryDependencies,
  resolveRecoveryArtifact,
  summarizeRecoveryCleanup,
  type RecoveryArtifactReference,
  type RecoveryCleanupReport,
} from "./doctor-session-sqlite-recovery-inventory.js";
import {
  createRecoveryDestinationVerifier,
  verifyHistoricalMigrationArtifact,
} from "./doctor-session-sqlite-verification.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";
import { retireUpdateCaptures } from "./update-capture-cleanup.js";
import {
  assertSessionArchiveBackupsCurrent,
  assertSessionArchivePathsInactive,
  assertSessionArchiveRetirementOptions,
  assertSessionArchiveSelectionCurrent,
  recordSessionArchiveRetirement,
  selectSessionArchiveRetirement,
} from "./update-cleanup-session-archives.js";
import type { RecoveryRetirementParams } from "./update-cleanup-types.js";
import {
  assertUnmanifestedSelectionCurrent,
  retireUnmanifestedRecovery,
  selectUnmanifestedRecovery,
} from "./update-cleanup-unmanifested.js";

/** Coalesce only exact raw copies; the surviving original preserves every rollback byte. */
export async function settleDuplicateSessionSqliteArchives(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets: readonly SessionSqliteMigrationTargetInput[];
}) {
  const {
    claims,
    inventory: { artifacts, references },
  } = collectHistoricalArchiveSources(params);
  const failures: Array<{
    target: SessionSqliteMigrationTargetInput;
    issues: DoctorSessionSqliteIssue[];
  }> = [];
  const recordFailure = (target: SessionSqliteMigrationTargetInput, message: string) => {
    failures.push({
      target,
      issues: [
        { code: "historical_transcript_deferred", message: `${message}; original retained.` },
      ],
    });
  };
  const survivors = new Map<string, RecoveryArtifactReference[]>();
  const selected: RecoveryCleanupReport["artifacts"] = [];
  const artifactsByPath = new Map<string, (typeof artifacts)[number]>();
  for (const item of artifacts) {
    if (!artifactsByPath.has(item.path)) {
      artifactsByPath.set(item.path, item);
    }
  }
  const replacements = new Map<string, RecoveryArtifactReference["move"]>();
  const assertSurvivor = (refs: RecoveryArtifactReference[]) => {
    const move = survivors.get(refs[0]!.move.archivePath)![0]!.move;
    if (hasSymbolicLinkInDirectoryPath(path.dirname(move.archivePath))) {
      throw new Error("Retained duplicate archive directory changed.");
    }
    assertRecoveryOriginal(move.archivePath, move.artifact!);
  };
  for (const group of claims) {
    const target = group[0]![0]!.target;
    if (
      !params.targets.some(
        (candidate) =>
          candidate.agentId === target.agentId &&
          candidate.storePath === target.storePath &&
          candidate.sqlitePath === target.sqlitePath,
      )
    ) {
      continue;
    }
    const survivor = group.find((refs) =>
      refs.every((ref) => ref.move.artifact!.disposal.state === "retained"),
    );
    if (!survivor) {
      continue;
    }
    for (const refs of group.filter((candidate) => candidate !== survivor)) {
      const item = artifactsByPath.get(refs[0]!.move.archivePath)!;
      survivors.set(item.path, survivor);
      try {
        assertSurvivor(refs);
        const artifact = resolveRecoveryArtifact(refs)!;
        if (
          refs.some((ref) => ref.move.artifact!.disposal.state === "disposed") &&
          statMigrationPath(item.path)
        ) {
          throw new Error("Archive was recreated after disposal.");
        }
        if (artifact.disposal.state !== "disposed") {
          assertRecoveryOriginal(item.path, artifact);
          item.outcome = "candidate";
          selected.push(item);
        }
        replacements.set(item.path, survivor[0]!.move);
      } catch (error) {
        recordFailure(target, `${item.path}: ${String(error)}`);
      }
    }
  }
  await disposeRecoveryArtifacts({ selected, references, assertDestinations: assertSurvivor });
  for (const [archivePath] of replacements) {
    const refs = references.get(archivePath)!;
    if (refs.every((ref) => ref.move.artifact!.disposal.state === "disposed")) {
      assertSurvivor(refs);
    } else {
      replacements.delete(archivePath);
      const item = artifactsByPath.get(archivePath)!;
      recordFailure(refs[0]!.target, `${archivePath}: ${item.detail ?? item.reason}`);
    }
  }
  return [
    ...failures,
    ...coalesceSessionSqliteArchiveReferences(replacements, [
      ...new Set([...references.values()].flatMap((refs) => refs.map((ref) => ref.run))),
    ]),
  ];
}

export type { RecoveryRetirementParams } from "./update-cleanup-types.js";

function assertRecoveryStateWriteAllowed(stateDir: string, env: NodeJS.ProcessEnv) {
  return assertOpenClawStateWriteAllowedAtPath({
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
    env,
    recoverOrphanedSidecars: false,
  });
}

/** Manual cleanup still requires the Gateway to be stopped. */
export async function retireSessionSqliteRecovery(
  params: RecoveryRetirementParams,
): Promise<RecoveryCleanupReport> {
  await assertRecoveryStateWriteAllowed(params.preview.stateDir, params.env);
  return withDoctorSqliteMaintenanceLock({
    env: params.env,
    operation: "update recovery cleanup",
    run: (authority) => retireOwnedSessionSqliteRecovery(params, authority),
  });
}

/** Shared retirement under exclusive offline custody or the serving Gateway's live authority. */
export async function retireOwnedSessionSqliteRecovery(
  params: RecoveryRetirementParams,
  authority: { assertCurrent(): void },
): Promise<RecoveryCleanupReport> {
  authority.assertCurrent();
  const cfg = await params.readConfig();
  const inventory = collectUpdateCleanupInventory({ cfg, env: params.env });
  if (params.retireSessionArchive?.length) {
    return retireExplicitSessionArchives(params, authority, cfg, inventory);
  }
  const unmanifested = selectUnmanifestedRecovery({
    inventory,
    cfg,
    env: params.env,
    paths: params.includeUnmanifested,
  });
  const { report, references, manifestPaths, captureIdentities } = inventory;
  authority.assertCurrent();
  if (
    report.stateDir !== params.preview.stateDir ||
    JSON.stringify(report.artifacts) !== JSON.stringify(params.preview.artifacts)
  ) {
    throw new Error("Recovery selection changed; preview cleanup again.");
  }
  await assertRecoveryStateWriteAllowed(report.stateDir, params.env);
  const adoptions = new Map<RecoveryArtifactReference, MigrationArtifact>();
  const verification: MigrationArtifactVerification = new Map();
  const assertDestinations = createRecoveryDestinationVerifier(report.stateDir, () =>
    authority.assertCurrent(),
  );
  const originals = report.artifacts.filter(
    (item) =>
      item.kind !== "update-capture" &&
      !unmanifested.has(item.path) &&
      (item.outcome === "candidate" || item.outcome === "verification-required"),
  );
  // Unfinished/blocked historical originals may already be protected. Their
  // retained references still have unknown dependencies when proof is absent.
  const deferOriginalDisposal =
    params.verifyHistorical === false &&
    report.artifacts.some((item) => references.get(item.path)?.some((ref) => !ref.move.artifact));
  for (const [index, item] of originals.entries()) {
    params.onProgress?.({
      phase: "verifying",
      path: item.path,
      index: index + 1,
      total: originals.length,
      bytes: item.bytes,
    });
    if (deferOriginalDisposal) {
      // Historical indexes can reference originals in other manifests. Without
      // that verification the dependency graph is incomplete, so defer original
      // disposal as a group. Captures retain their independent eligibility rules.
      if (item.outcome === "candidate") {
        item.reason = "historical-recovery-dependencies-unverified";
      }
      item.outcome = "protected";
      continue;
    }
    if (item.outcome === "verification-required") {
      const refs = references.get(item.path)!;
      try {
        for (const ref of refs) {
          if (ref.move.artifact) {
            continue;
          }
          const artifact = verifyHistoricalMigrationArtifact({
            target: ref.target,
            move: ref.move,
            env: params.env,
          });
          if (!artifact) {
            throw new Error("historical-import-proof-unavailable");
          }
          adoptions.set(ref, artifact);
        }
        item.outcome = "candidate";
        item.reason = "verified-historical-import";
      } catch (error) {
        item.outcome = "protected";
        item.reason = "historical-import-proof-unavailable";
        item.detail = String(error);
      }
    }
    if (item.outcome !== "candidate") {
      continue;
    }
    try {
      const refs = references.get(item.path)!;
      const artifact = resolveRecoveryArtifact(refs) ?? adoptions.get(refs[0]!)!;
      assertRecoveryOriginal(item.path, artifact, verification);
    } catch (error) {
      item.outcome = "blocked";
      item.reason = "artifact-verification-failed";
      item.detail = String(error);
    }
  }
  // Historical adoption also opens SQLite readers; finish those before fencing sidecar state.
  for (const item of report.artifacts) {
    if (
      item.outcome !== "candidate" ||
      item.kind === "update-capture" ||
      unmanifested.has(item.path)
    ) {
      continue;
    }
    try {
      assertDestinations(references.get(item.path)!);
    } catch (error) {
      item.outcome = "blocked";
      item.reason = "destination-verification-failed";
      item.detail = String(error);
    }
  }
  // Verified historical dependencies affect selection now, but stay provisional until consent.
  protectRecoveryDependencies(report.artifacts, references, adoptions);
  const verified = summarizeRecoveryCleanup(
    report.stateDir,
    report.artifacts,
    "preview",
    report.missingOriginals,
  );
  const candidates = verified.artifacts.filter((item) => item.outcome === "candidate");
  const explicit = candidates.filter((item) => unmanifested.has(item.path));
  const selected = candidates.filter(
    (item) => item.kind !== "update-capture" && !unmanifested.has(item.path),
  );
  const captures = candidates.filter(
    (item) => item.kind === "update-capture" && !unmanifested.has(item.path),
  );
  if (!(await params.confirm(verified))) {
    return { ...verified, status: "refused" };
  }
  authority.assertCurrent();
  const currentConfig = await params.readConfig();
  const rechecked = collectUpdateCleanupInventory({ cfg: currentConfig, env: params.env });
  const currentUnmanifested = selectUnmanifestedRecovery({
    inventory: rechecked,
    cfg: currentConfig,
    env: params.env,
    paths: params.includeUnmanifested,
  });
  assertUnmanifestedSelectionCurrent(unmanifested, currentUnmanifested);
  // Existing artifacts can become protected during confirmation, not only newly added manifests.
  // Revalidate the whole selection before retiring any dependent originals.
  if (
    rechecked.report.stateDir !== report.stateDir ||
    JSON.stringify(rechecked.manifestPaths) !== JSON.stringify(manifestPaths) ||
    JSON.stringify(rechecked.report.artifacts) !== JSON.stringify(params.preview.artifacts)
  ) {
    throw new Error("Recovery selection changed during confirmation; preview again.");
  }
  const manifests = (refs: typeof references) =>
    new Map([...refs.values()].flat().map(({ run }) => [run.manifestPath, run.manifest]));
  const currentManifests = manifests(rechecked.references);
  for (const [manifestPath, manifest] of manifests(references)) {
    if (JSON.stringify(currentManifests.get(manifestPath)) !== JSON.stringify(manifest)) {
      throw new Error("Recovery manifest changed during confirmation; preview again.");
    }
  }
  for (const ref of [...references.values()].flat()) {
    if (
      !(rechecked.references.get(ref.move.archivePath) ?? []).some(
        (current) =>
          current.trusted === ref.trusted &&
          current.target.storePath === ref.target.storePath &&
          current.target.sqlitePath === ref.target.sqlitePath,
      )
    ) {
      throw new Error("Recovery target changed during confirmation; preview again.");
    }
  }
  await assertRecoveryStateWriteAllowed(report.stateDir, params.env);
  authority.assertCurrent();
  for (const item of selected) {
    const refs = references.get(item.path)!;
    assertDestinations(refs);
    assertRecoveryOriginal(
      item.path,
      resolveRecoveryArtifact(refs) ?? adoptions.get(refs[0]!)!,
      verification,
    );
  }
  for (const [ref, artifact] of adoptions) {
    if (!selected.some((item) => item.path === ref.move.archivePath)) {
      continue;
    }
    if (ref.run.manifest.manifestVersion < 3) {
      ref.run.manifest.manifestVersion = 3;
    }
    for (const move of [...ref.target.plannedMoves, ...ref.target.completedMoves]) {
      if (move.archivePath === ref.move.archivePath) {
        move.artifact = artifact;
      }
    }
  }
  await disposeRecoveryArtifacts({
    selected,
    references,
    assertDestinations,
    assertCurrent: () => authority.assertCurrent(),
    verification,
    onProgress: params.onProgress,
  });
  await retireUpdateCaptures({
    selected: captures,
    identities: captureIdentities,
    assertCurrent: () => authority.assertCurrent(),
    onProgress: (item, index) =>
      params.onProgress?.({
        phase: "removing-capture",
        path: item.path,
        index: index + 1,
        total: captures.length,
        bytes: item.bytes,
      }),
  });
  await retireUnmanifestedRecovery({
    selected: explicit,
    identities: unmanifested,
    assertCurrent: () => authority.assertCurrent(),
    assertReferences: async (item) => {
      const effectConfig = await params.readConfig();
      authority.assertCurrent();
      const fresh = collectUpdateCleanupInventory({ cfg: effectConfig, env: params.env });
      const selection = selectUnmanifestedRecovery({
        inventory: fresh,
        cfg: effectConfig,
        env: params.env,
        paths: [item.path],
      });
      assertUnmanifestedSelectionCurrent(
        new Map([[item.path, unmanifested.get(item.path)!]]),
        selection,
      );
    },
    onProgress: (item, index) =>
      params.onProgress?.({
        phase: "removing-unmanifested",
        path: item.path,
        index: index + 1,
        total: explicit.length,
        bytes: item.bytes,
      }),
  });
  return summarizeRecoveryCleanup(
    report.stateDir,
    report.artifacts,
    report.artifacts.some((item) => item.outcome === "failed" || item.outcome === "blocked")
      ? "blocked"
      : "complete",
    report.missingOriginals,
  );
}

async function retireExplicitSessionArchives(
  params: RecoveryRetirementParams,
  authority: { assertCurrent(): void },
  cfg: OpenClawConfig,
  inventory: ReturnType<typeof collectUpdateCleanupInventory>,
): Promise<RecoveryCleanupReport> {
  assertSessionArchiveRetirementOptions(params);
  const select = (current: typeof inventory, config: OpenClawConfig) =>
    selectSessionArchiveRetirement({
      inventory: current,
      cfg: config,
      env: params.env,
      paths: params.retireSessionArchive!,
      backupDirectory: params.archiveBackup!,
    });
  const initial = select(inventory, cfg);
  const { report } = inventory;
  if (
    report.stateDir !== params.preview.stateDir ||
    JSON.stringify(report.artifacts) !== JSON.stringify(params.preview.artifacts)
  ) {
    throw new Error("Recovery selection changed; preview cleanup again.");
  }
  authority.assertCurrent();
  await assertRecoveryStateWriteAllowed(report.stateDir, params.env);
  if (!(await params.confirm(report))) {
    return { ...report, status: "refused" };
  }
  authority.assertCurrent();
  const currentConfig = await params.readConfig();
  const current = collectUpdateCleanupInventory({ cfg: currentConfig, env: params.env });
  const selection = select(current, currentConfig);
  assertSessionArchiveSelectionCurrent(
    { inventory, selection: initial },
    { inventory: current, selection },
  );
  await assertRecoveryStateWriteAllowed(report.stateDir, params.env);
  authority.assertCurrent();
  assertSessionArchiveBackupsCurrent(selection);
  recordSessionArchiveRetirement(selection);
  const selected = selection.originals
    .map(({ item }) => item)
    .filter((item) => item.outcome === "candidate");
  await disposeRecoveryArtifacts({
    selected,
    references: current.references,
    assertDestinations: (refs) => assertSessionArchiveBackupsCurrent(selection, refs),
    beforeEffect: async () =>
      assertSessionArchivePathsInactive(
        current,
        await params.readConfig(),
        params.env,
        selection.originals.map(({ item }) => item.path),
      ),
    assertCurrent: () => authority.assertCurrent(),
    onProgress: params.onProgress,
  });
  return summarizeRecoveryCleanup(
    current.report.stateDir,
    current.report.artifacts,
    selected.some((item) => item.outcome === "failed" || item.outcome === "blocked")
      ? "blocked"
      : "complete",
    current.report.missingOriginals,
  );
}

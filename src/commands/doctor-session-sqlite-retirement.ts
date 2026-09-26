/** Retirement of producer-verified originals; never a suffix deletion policy. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import {
  isPendingMigrationArtifactClaim,
  moveMigrationArtifact,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifact,
  type MigrationArtifactIdentity,
} from "../infra/session-sqlite-migration-artifact.js";
import type { DoctorSessionSqliteIssue } from "../infra/session-sqlite-migration-issues.js";
import {
  hasSymbolicLinkInDirectoryPath,
  readSessionSqliteMigrationManifest,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationTargetInput,
} from "../infra/session-sqlite-migration-manifest.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership.js";
import { collectHistoricalArchiveSources } from "./doctor-session-sqlite-discovery.js";
import { coalesceSessionSqliteArchiveReferences } from "./doctor-session-sqlite-migration-coalesce.js";
import {
  collectRecoveryInventory,
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

function assertRecoveryOriginal(
  archivePath: string,
  artifact: MigrationArtifact,
): MigrationArtifactIdentity | undefined {
  const currentPath = statMigrationPath(archivePath)
    ? archivePath
    : artifact.disposal.state === "pending-disposal"
      ? artifact.disposal.claimPath
      : archivePath;
  if (!statMigrationPath(currentPath)) {
    if (
      artifact.disposal.state === "pending-disposal" &&
      artifact.disposal.phase === "unlink-pending"
    ) {
      return undefined;
    }
    throw new Error("artifact is unexpectedly missing");
  }
  const links = isPendingMigrationArtifactClaim(archivePath, artifact) ? 2n : 1n;
  const identity = readMigrationArtifactIdentity(currentPath, links);
  if (
    !sameMigrationArtifact(identity, artifact.identity, {
      // APFS can assign a different st_dev after reboot while the retained inode and bytes stay
      // unchanged; the receipt still identifies the same protected recovery artifact.
      ignoreDevice: true,
    })
  ) {
    throw new Error("artifact identity or contents changed");
  }
  return identity;
}

/** Coalesce only exact raw copies; the surviving original preserves every rollback byte. */
export async function settleDuplicateSessionSqliteArchives(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets: readonly SessionSqliteMigrationTargetInput[];
}) {
  const {
    claims,
    inventory: { report, references },
  } = collectHistoricalArchiveSources(params);
  const failures: Array<{
    target: SessionSqliteMigrationTargetInput;
    issues: DoctorSessionSqliteIssue[];
  }> = [];
  const survivors = new Map<string, RecoveryArtifactReference[]>();
  const selected: RecoveryCleanupReport["artifacts"] = [];
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
      const item = report.artifacts.find(
        (candidate) => candidate.path === refs[0]!.move.archivePath,
      )!;
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
        failures.push({
          target,
          issues: [
            {
              code: "historical_transcript_deferred",
              message: `${item.path}: ${String(error)}; original retained.`,
            },
          ],
        });
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
      const item = selected.find((candidate) => candidate.path === archivePath)!;
      failures.push({
        target: refs[0]!.target,
        issues: [
          {
            code: "historical_transcript_deferred",
            message: `${archivePath}: ${item.detail ?? item.reason}; original retained.`,
          },
        ],
      });
    }
  }
  return [
    ...failures,
    ...coalesceSessionSqliteArchiveReferences(replacements, [
      ...new Set([...references.values()].flatMap((refs) => refs.map((ref) => ref.run))),
    ]),
  ];
}

/** The CLI supplies source-only configuration again under authority before exact confirmation. */
export async function retireSessionSqliteRecovery(params: {
  env: NodeJS.ProcessEnv;
  preview: RecoveryCleanupReport;
  readConfig(): Promise<OpenClawConfig>;
  confirm(report: RecoveryCleanupReport): Promise<boolean>;
}): Promise<RecoveryCleanupReport> {
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: path.join(params.preview.stateDir, "state", "openclaw.sqlite"),
    env: params.env,
    recoverOrphanedSidecars: false,
  });
  return withDoctorSqliteMaintenanceLock({
    env: params.env,
    operation: "update recovery cleanup",
    run: async (authority) => {
      const { report, references, manifestPaths } = collectRecoveryInventory({
        cfg: await params.readConfig(),
        env: params.env,
      });
      authority.assertCurrent();
      if (
        report.stateDir !== params.preview.stateDir ||
        JSON.stringify(report.artifacts) !== JSON.stringify(params.preview.artifacts)
      ) {
        throw new Error("Recovery selection changed; preview cleanup again.");
      }
      await assertOpenClawStateWriteAllowedAtPath({
        databasePath: path.join(report.stateDir, "state", "openclaw.sqlite"),
        env: params.env,
        recoverOrphanedSidecars: false,
      });
      const adoptions = new Map<RecoveryArtifactReference, MigrationArtifact>();
      const assertDestinations = createRecoveryDestinationVerifier(report.stateDir);
      for (const item of report.artifacts) {
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
          assertRecoveryOriginal(item.path, artifact);
        } catch (error) {
          item.outcome = "blocked";
          item.reason = "artifact-verification-failed";
          item.detail = String(error);
        }
      }
      // Historical adoption also opens SQLite readers; finish those before fencing sidecar state.
      for (const item of report.artifacts) {
        if (item.outcome !== "candidate") {
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
      const verified = summarizeRecoveryCleanup(report.stateDir, report.artifacts, "preview");
      const selected = verified.artifacts.filter((item) => item.outcome === "candidate");
      if (!(await params.confirm(verified))) {
        return { ...verified, status: "refused" };
      }
      authority.assertCurrent();
      const currentConfig = await params.readConfig();
      const rechecked = collectRecoveryInventory({ cfg: currentConfig, env: params.env });
      // Existing artifacts can become protected during confirmation, not only newly added manifests.
      // Revalidate the whole selection before retiring any dependent originals.
      if (
        rechecked.report.stateDir !== report.stateDir ||
        JSON.stringify(rechecked.manifestPaths) !== JSON.stringify(manifestPaths) ||
        JSON.stringify(rechecked.report.artifacts) !== JSON.stringify(params.preview.artifacts)
      ) {
        throw new Error("Recovery selection changed during confirmation; preview again.");
      }
      for (const refs of references.values()) {
        for (const ref of refs) {
          if (
            JSON.stringify(readSessionSqliteMigrationManifest(ref.run.manifestPath)) !==
            JSON.stringify(ref.run.manifest)
          ) {
            throw new Error("Recovery manifest changed during confirmation; preview again.");
          }
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
      }
      await assertOpenClawStateWriteAllowedAtPath({
        databasePath: path.join(report.stateDir, "state", "openclaw.sqlite"),
        env: params.env,
        recoverOrphanedSidecars: false,
      });
      authority.assertCurrent();
      for (const item of selected) {
        const refs = references.get(item.path)!;
        assertDestinations(refs);
        assertRecoveryOriginal(
          item.path,
          resolveRecoveryArtifact(refs) ?? adoptions.get(refs[0]!)!,
        );
      }
      for (const [ref, artifact] of adoptions) {
        if (!selected.some((item) => item.path === ref.move.archivePath)) {
          continue;
        }
        if (ref.run.manifest.manifestVersion !== 4) {
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
      });
      return summarizeRecoveryCleanup(
        report.stateDir,
        report.artifacts,
        report.artifacts.some((item) => item.outcome === "failed" || item.outcome === "blocked")
          ? "blocked"
          : "complete",
      );
    },
  });
}

async function disposeRecoveryArtifacts({
  selected,
  references,
  assertDestinations,
  assertCurrent,
}: {
  selected: RecoveryCleanupReport["artifacts"];
  references: Map<string, RecoveryArtifactReference[]>;
  assertDestinations: (refs: RecoveryArtifactReference[]) => void;
  assertCurrent?: () => void;
}): Promise<void> {
  const runs = new Set<ActiveSessionSqliteMigrationRun>();
  for (const item of selected) {
    const refs = references.get(item.path)!;
    const pending = refs
      .map(({ move }) => move.artifact!.disposal)
      .find((receipt) => receipt.state === "pending-disposal");
    const disposal: MigrationArtifact["disposal"] = pending ?? {
      state: "pending-disposal",
      intendedAt: new Date().toISOString(),
      phase: "intent",
      claimPath: path.join(path.dirname(item.path), `.cleanup-${randomUUID()}`),
    };
    for (const ref of refs) {
      for (const move of [...ref.target.plannedMoves, ...ref.target.completedMoves]) {
        if (move.archivePath === item.path && move.artifact) {
          move.artifact.disposal = disposal;
        }
      }
      runs.add(ref.run);
    }
  }
  // Every referencing manifest is durable before the first artifact in this selection moves.
  for (const run of runs) {
    writeSessionSqliteMigrationManifest(run);
  }
  let activeItem: (typeof selected)[number] | undefined;
  const claims = selected.map((item) => {
    const refs = references.get(item.path)!;
    const artifact = refs[0]!.move.artifact!;
    const disposal = artifact.disposal;
    if (
      disposal.state !== "pending-disposal" ||
      path.dirname(disposal.claimPath) !== path.dirname(item.path) ||
      !path.basename(disposal.claimPath).startsWith(".cleanup-")
    ) {
      throw new Error("invalid disposal claim");
    }
    return { item, refs, artifact, disposal, present: false };
  });
  try {
    // Claim the entire selection before retiring any member: a changed later transcript
    // must not lose its index or siblings. Durable intent also owns partially moved claims.
    for (const claim of claims) {
      const { item, refs, artifact, disposal } = claim;
      activeItem = item;
      assertCurrent?.();
      assertDestinations(refs);
      if (hasSymbolicLinkInDirectoryPath(path.dirname(item.path))) {
        throw new Error("archive directory changed");
      }
      if (statMigrationPath(item.path)) {
        if (disposal.phase === "unlink-pending") {
          throw new Error("archive was recreated after claim");
        }
        const identity = assertRecoveryOriginal(item.path, artifact);
        if (!identity) {
          throw new Error("artifact is unexpectedly missing");
        }
        await moveMigrationArtifact(item.path, disposal.claimPath, identity);
      }
      assertCurrent?.();
      assertDestinations(refs);
      assertRecoveryOriginal(item.path, artifact);
      claim.present = statMigrationPath(disposal.claimPath) !== undefined;
      disposal.phase = "unlink-pending";
    }
    // All claims, including their unlink intents, must survive a crash before disposal starts.
    for (const run of runs) {
      writeSessionSqliteMigrationManifest(run);
    }
    for (const { item, artifact, disposal, present } of claims) {
      activeItem = item;
      if (hasSymbolicLinkInDirectoryPath(path.dirname(item.path))) {
        throw new Error("archive directory changed");
      }
      if (statMigrationPath(item.path)) {
        throw new Error("archive was recreated after claim");
      }
      assertRecoveryOriginal(item.path, artifact);
      if (present !== (statMigrationPath(disposal.claimPath) !== undefined)) {
        throw new Error("disposal claim changed after intent");
      }
    }
    assertCurrent?.();
    for (const { item, refs } of claims) {
      activeItem = item;
      assertDestinations(refs);
    }
    // No awaits between selection validation and its unlinks. Completion I/O comes after
    // this commit section; durable unlink-pending receipts make every partial failure retryable.
    for (const { item, artifact, disposal } of claims) {
      activeItem = item;
      const claim = statMigrationPath(disposal.claimPath);
      if (claim) {
        fs.unlinkSync(disposal.claimPath);
        item.removedBytes = artifact.identity.size;
      }
      item.outcome = claim ? "removed" : "disposed";
      item.bytes = claim ? artifact.identity.size : 0;
      item.reason = claim ? "rollback-original-retired" : "completed-interrupted-disposal";
    }
    const syncedDirectories = new Set<string>();
    for (const { item, refs } of claims) {
      activeItem = item;
      const directory = path.dirname(item.path);
      if (item.outcome === "removed" && !syncedDirectories.has(directory)) {
        requireDirectorySync(await syncDirectory(directory), "Recovery artifact removal");
        syncedDirectories.add(directory);
      }
      assertCurrent?.();
      assertDestinations(refs);
      for (const ref of refs) {
        for (const move of [...ref.target.plannedMoves, ...ref.target.completedMoves]) {
          if (move.archivePath === item.path && move.artifact) {
            move.artifact.disposal = {
              state: "disposed",
              disposedAt: new Date().toISOString(),
            };
          }
        }
      }
    }
    for (const run of runs) {
      writeSessionSqliteMigrationManifest(run);
    }
  } catch (error) {
    if (activeItem) {
      activeItem.outcome = "failed";
      activeItem.reason = "artifact-retirement-failed";
      activeItem.detail = String(error);
    }
    for (const item of selected) {
      if (item.outcome === "candidate") {
        item.outcome = "blocked";
        item.reason = "retirement-stopped";
      }
    }
  }
}

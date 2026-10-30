/** Durable disposal of selected recovery originals; callers own admission and maintenance authority. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import {
  isPendingMigrationArtifactClaim,
  moveMigrationArtifact,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifact,
  type MigrationArtifactIdentity,
  type MigrationArtifactVerification,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  hasSymbolicLinkInDirectoryPath,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationTargetManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import type {
  RecoveryArtifactReference,
  RecoveryCleanupReport,
} from "./doctor-session-sqlite-recovery-inventory.js";
import type { RecoveryCleanupProgress } from "./update-cleanup-types.js";

export function assertRecoveryOriginal(
  archivePath: string,
  artifact: MigrationArtifact,
  verification?: MigrationArtifactVerification,
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
  const identity = readMigrationArtifactIdentity(currentPath, links, undefined, verification);
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

export async function disposeRecoveryArtifacts({
  selected,
  references,
  assertDestinations,
  beforeEffect,
  assertCurrent,
  verification,
  onProgress,
}: {
  selected: RecoveryCleanupReport["artifacts"];
  references: Map<string, RecoveryArtifactReference[]>;
  assertDestinations: (refs: RecoveryArtifactReference[]) => void;
  beforeEffect?: () => Promise<void>;
  assertCurrent?: () => void;
  verification?: MigrationArtifactVerification;
  onProgress?: (progress: RecoveryCleanupProgress) => void;
}): Promise<void> {
  const runs = new Set<ActiveSessionSqliteMigrationRun>();
  const movesByTarget = new Map<
    SessionSqliteMigrationTargetManifest,
    Map<string, SessionSqliteMigrationMove[]>
  >();
  const movesFor = (ref: RecoveryArtifactReference, archivePath: string) => {
    let byPath = movesByTarget.get(ref.target);
    if (!byPath) {
      byPath = new Map();
      for (const move of [...ref.target.plannedMoves, ...ref.target.completedMoves]) {
        if (move.artifact) {
          const moves = byPath.get(move.archivePath) ?? [];
          moves.push(move);
          byPath.set(move.archivePath, moves);
        }
      }
      movesByTarget.set(ref.target, byPath);
    }
    return byPath.get(archivePath) ?? [];
  };
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
      for (const move of movesFor(ref, item.path)) {
        move.artifact!.disposal = disposal;
      }
      runs.add(ref.run);
    }
  }
  // Every referencing manifest is durable before the first artifact in this selection moves.
  for (const run of runs) {
    assertCurrent?.();
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
    for (const [index, claim] of claims.entries()) {
      const { item, refs, artifact, disposal } = claim;
      activeItem = item;
      onProgress?.({
        phase: "claiming",
        path: item.path,
        index: index + 1,
        total: claims.length,
        bytes: item.bytes,
      });
      if (beforeEffect) {
        await beforeEffect();
      }
      assertCurrent?.();
      assertDestinations(refs);
      if (hasSymbolicLinkInDirectoryPath(path.dirname(item.path))) {
        throw new Error("archive directory changed");
      }
      if (statMigrationPath(item.path)) {
        if (disposal.phase === "unlink-pending") {
          throw new Error("archive was recreated after claim");
        }
        const identity = assertRecoveryOriginal(item.path, artifact, verification);
        if (!identity) {
          throw new Error("artifact is unexpectedly missing");
        }
        await moveMigrationArtifact(
          item.path,
          disposal.claimPath,
          identity,
          () => {
            // Publication awaited durable I/O; the host may have revoked this worker.
            assertCurrent?.();
            return undefined;
          },
          undefined,
          verification,
        );
      }
      assertCurrent?.();
      assertDestinations(refs);
      assertRecoveryOriginal(item.path, artifact, verification);
      claim.present = statMigrationPath(disposal.claimPath) !== undefined;
      disposal.phase = "unlink-pending";
    }
    // All claims, including their unlink intents, must survive a crash before disposal starts.
    for (const run of runs) {
      assertCurrent?.();
      writeSessionSqliteMigrationManifest(run);
    }
    if (beforeEffect) {
      await beforeEffect();
    }
    assertCurrent?.();
    for (const { item, artifact, disposal, present } of claims) {
      activeItem = item;
      if (hasSymbolicLinkInDirectoryPath(path.dirname(item.path))) {
        throw new Error("archive directory changed");
      }
      if (statMigrationPath(item.path)) {
        throw new Error("archive was recreated after claim");
      }
      assertRecoveryOriginal(item.path, artifact, verification);
      if (present !== (statMigrationPath(disposal.claimPath) !== undefined)) {
        throw new Error("disposal claim changed after intent");
      }
    }
    assertCurrent?.();
    for (const { item, refs } of claims) {
      activeItem = item;
      assertDestinations(refs);
    }
    // The host can revoke worker authority even between synchronous unlinks.
    // Durable unlink-pending receipts make every partial failure retryable.
    for (const { item, artifact, disposal } of claims) {
      activeItem = item;
      const claim = statMigrationPath(disposal.claimPath);
      if (claim) {
        assertCurrent?.();
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
        for (const move of movesFor(ref, item.path)) {
          move.artifact!.disposal = {
            state: "disposed",
            disposedAt: new Date().toISOString(),
          };
        }
      }
    }
    for (const run of runs) {
      assertCurrent?.();
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
